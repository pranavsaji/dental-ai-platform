// F2: TOTP MFA endpoints. Two entry paths share these flows:
//   - login-time (stage tokens from POST /auth/login: mfaRequired / mfaSetupRequired)
//   - account page (an authenticated session enrolling voluntarily)
// Secrets are stored on the user row at setup/start but count as enrolled only
// after setup/confirm proves the authenticator produces valid codes.

import {
  BadRequestException, Body, Controller, Get, Inject, Post, Req, Res,
  UnauthorizedException, UseGuards
} from "@nestjs/common";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import { toDataURL } from "qrcode";
import { eq } from "drizzle-orm";
import { scryptHash, scryptVerify, users } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CurrentUser, JwtGuard } from "./auth";
import { generateRecoveryCodes, mfaEnforcedForAdmins, verifyMfaToken } from "./mfa";
import {
  JWT_SECRET, SESSION_COOKIE, issueSession, readCookie, type SessionUser
} from "./session";

const ISSUER = "Dental AI Platform";

@Controller("auth/mfa")
export class MfaController {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  /**
   * Resolve who is acting: a login-flow stage token, or an existing session
   * (cookie/Bearer) for account-page enrollment. Stage tokens take precedence.
   */
  private async resolveUser(req: Request, mfaToken: string | undefined, stage: "mfa" | "mfa_setup") {
    let userId: number;
    if (mfaToken) {
      userId = verifyMfaToken(mfaToken, stage);
    } else {
      const header = req.headers.authorization;
      const token = header?.startsWith("Bearer ") ? header.slice(7) : readCookie(req, SESSION_COOKIE);
      if (!token) throw new UnauthorizedException("Missing credentials");
      try {
        userId = (jwt.verify(token, JWT_SECRET()) as unknown as SessionUser).sub;
      } catch {
        throw new UnauthorizedException("Invalid token");
      }
    }
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.disabledAt) throw new UnauthorizedException("Account unavailable");
    return { user, viaLoginFlow: Boolean(mfaToken) };
  }

  private sessionFor(user: typeof users.$inferSelect) {
    return {
      sub: user.id, orgId: user.orgId, email: user.email,
      name: user.name, role: user.role, locationId: user.locationId,
      providerSourceId: user.providerSourceId ?? null
    };
  }

  /** Start (or restart) enrollment: new secret + QR. Not yet enrolled. */
  @Post("setup/start")
  async setupStart(@Req() req: Request, @Body() body: { mfaToken?: string }) {
    const { user } = await this.resolveUser(req, body.mfaToken, "mfa_setup");
    if (user.mfaEnrolledAt) throw new BadRequestException("MFA already enrolled — reset it first");
    const secret = authenticator.generateSecret();
    await this.db.update(users).set({ mfaSecret: secret }).where(eq(users.id, user.id));
    const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
    return { secret, otpauthUrl, qrDataUrl: await toDataURL(otpauthUrl) };
  }

  /** Confirm enrollment with a live code; returns one-time recovery codes. */
  @Post("setup/confirm")
  async setupConfirm(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { mfaToken?: string; code?: string }
  ) {
    const { user, viaLoginFlow } = await this.resolveUser(req, body.mfaToken, "mfa_setup");
    if (!user.mfaSecret) throw new BadRequestException("Start setup first");
    if (!authenticator.check(body.code ?? "", user.mfaSecret)) {
      throw new UnauthorizedException("Code did not match — check your authenticator app");
    }
    const recoveryCodes = generateRecoveryCodes();
    await this.db.update(users).set({
      mfaEnrolledAt: new Date(),
      mfaRecoveryCodes: recoveryCodes.map((c) => scryptHash(c))
    }).where(eq(users.id, user.id));
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "auth.mfa.enrolled", resource: "user", resourceId: String(user.id)
    });

    // Login-flow enrollment continues straight into a session.
    if (viaLoginFlow) {
      const session = this.sessionFor(user);
      const token = issueSession(res, session);
      await this.audit.log({
        orgId: user.orgId, actorType: "user", actor: user.email,
        action: "auth.login", resource: "session", purpose: "mfa setup completed"
      });
      return { recoveryCodes, token, user: session };
    }
    return { recoveryCodes };
  }

  /** Login step 2: TOTP code (or a one-time recovery code) ⇒ session. */
  @Post("verify")
  async verify(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { mfaToken?: string; code?: string }
  ) {
    if (!body.mfaToken) throw new BadRequestException("mfaToken required");
    const { user } = await this.resolveUser(req, body.mfaToken, "mfa");
    if (!user.mfaSecret || !user.mfaEnrolledAt) throw new BadRequestException("MFA not enrolled");
    const code = (body.code ?? "").trim();

    let ok = authenticator.check(code, user.mfaSecret);
    let usedRecovery = false;
    if (!ok && code.length >= 8) {
      // Recovery codes are single-use: a match is consumed immediately.
      const hashes = (user.mfaRecoveryCodes as string[]) ?? [];
      const idx = hashes.findIndex((h) => scryptVerify(code, h));
      if (idx >= 0) {
        ok = usedRecovery = true;
        await this.db.update(users)
          .set({ mfaRecoveryCodes: hashes.filter((_, i) => i !== idx) })
          .where(eq(users.id, user.id));
      }
    }
    if (!ok) {
      await this.audit.log({
        orgId: user.orgId, actorType: "user", actor: user.email,
        action: "auth.mfa.failed", resource: "session"
      });
      throw new UnauthorizedException("Invalid code");
    }

    const session = this.sessionFor(user);
    const token = issueSession(res, session);
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "auth.login", resource: "session",
      purpose: usedRecovery ? "mfa recovery code" : "mfa totp"
    });
    return { token, user: session };
  }

  /** Account page: enrollment state for the signed-in user. */
  @Get("status")
  @UseGuards(JwtGuard)
  async status(@CurrentUser() me: SessionUser) {
    const [user] = await this.db.select().from(users).where(eq(users.id, me.sub));
    return {
      enrolled: Boolean(user?.mfaEnrolledAt),
      enforcedForAdmins: mfaEnforcedForAdmins(),
      recoveryCodesLeft: ((user?.mfaRecoveryCodes as string[]) ?? []).length
    };
  }
}
