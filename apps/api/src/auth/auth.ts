import {
  Body, CanActivate, Controller, ExecutionContext, Get, HttpException, Inject,
  Injectable, Post, Req, Res, UnauthorizedException, UseGuards, createParamDecorator
} from "@nestjs/common";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { users, scryptVerify } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import {
  CSRF_COOKIE, JWT_SECRET, SESSION_COOKIE, clearSessionCookies, issueSession,
  readCookie, type SessionUser
} from "./session";
import { mfaEnforcedForAdmins, signMfaToken } from "./mfa";

export type { SessionUser };

// F2: sessions ride an httpOnly cookie (see session.ts); Bearer stays for
// scripts. Cookie-authenticated mutations must pass the CSRF double-submit
// check, and every request re-checks users.disabled_at (30s cache) so
// disabling an account revokes access immediately (F3), not at token expiry.
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const disabledCache = new Map<number, { disabled: boolean; checkedAt: number }>();
const DISABLED_CACHE_MS = 30_000;

/** F3: called on disable/enable so revocation is immediate, not cache-delayed. */
export function invalidateDisabledCache(userId: number): void {
  disabledCache.delete(userId);
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(@Inject(DB) private db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const cookieToken = bearer ? null : readCookie(req, SESSION_COOKIE);
    const token = bearer ?? cookieToken;
    if (!token) throw new UnauthorizedException("Missing credentials");

    let user: SessionUser;
    try {
      user = jwt.verify(token, JWT_SECRET()) as unknown as SessionUser;
    } catch {
      throw new UnauthorizedException("Invalid token");
    }

    // CSRF double-submit — only for cookie-authenticated mutations. A cross-
    // site form can make the browser send the cookie but cannot set headers.
    if (cookieToken && MUTATING.has(req.method)) {
      const headerToken = req.headers["x-csrf-token"];
      if (!user.csrf || headerToken !== user.csrf) {
        throw new UnauthorizedException("CSRF token missing or invalid");
      }
    }

    if (await this.isDisabled(user.sub)) {
      throw new UnauthorizedException("Account disabled");
    }

    req.user = user;
    return true;
  }

  private async isDisabled(userId: number): Promise<boolean> {
    const cached = disabledCache.get(userId);
    if (cached && Date.now() - cached.checkedAt < DISABLED_CACHE_MS) return cached.disabled;
    const [row] = await this.db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId));
    const disabled = !row || row.disabledAt != null;
    disabledCache.set(userId, { disabled, checkedAt: Date.now() });
    return disabled;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => ctx.switchToHttp().getRequest().user
);

// Fixed-window brute-force limiter, in-memory (single API instance). A SOC 2
// CC6.1 control: repeated credential guessing is slowed and audit-logged.
const LOGIN_WINDOW_MS = 5 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function loginRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  @Post("login")
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { email?: string; password?: string }
  ) {
    const email = (body.email ?? "").toLowerCase().trim();
    if (loginRateLimited(`${req.ip}`)) {
      throw new HttpException("Too many login attempts; try again in a few minutes", 429);
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    // Null passwordHash = SSO-only account: password login always fails.
    if (!user || !user.passwordHash || !scryptVerify(body.password ?? "", user.passwordHash)) {
      if (user) {
        await this.audit.log({
          orgId: user.orgId, actorType: "user", actor: email,
          action: "auth.login.failed", resource: "session"
        });
      }
      throw new UnauthorizedException("Invalid credentials");
    }
    if (user.disabledAt) {
      await this.audit.log({
        orgId: user.orgId, actorType: "user", actor: email,
        action: "auth.login.disabled", resource: "session"
      });
      throw new UnauthorizedException("Account disabled");
    }

    // F2 MFA gates: an enrolled user must present a TOTP code; an admin who
    // hasn't enrolled must set MFA up at login when enforcement is on.
    if (user.mfaEnrolledAt) {
      return { mfaRequired: true, mfaToken: signMfaToken(user.id, "mfa") };
    }
    if (user.role === "admin" && mfaEnforcedForAdmins()) {
      return { mfaSetupRequired: true, mfaToken: signMfaToken(user.id, "mfa_setup") };
    }

    const session = {
      sub: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      role: user.role,
      locationId: user.locationId
    };
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "auth.login", resource: "session"
    });
    const token = issueSession(res, session);
    // token still returned for non-browser clients (Bearer); the web app
    // ignores it and relies on the httpOnly cookie.
    return { token, user: session };
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) res: Response) {
    clearSessionCookies(res);
    return { ok: true };
  }

  @Get("me")
  @UseGuards(JwtGuard)
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  // The web app reads the CSRF value from its (non-httpOnly) cookie; this
  // endpoint exists for clients that lost it (e.g. cookie cleared mid-session).
  @Get("csrf")
  @UseGuards(JwtGuard)
  csrf(@CurrentUser() user: SessionUser, @Req() req: Request) {
    return { csrf: user.csrf ?? readCookie(req, CSRF_COOKIE) ?? null };
  }
}
