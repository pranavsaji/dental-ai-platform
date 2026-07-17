// Browser-facing SSO endpoints. /auth/sso/login sends the user to the IdP;
// /auth/sso/callback turns a verified ID token into a platform session — set
// as httpOnly cookies (F2) — and redirects the web app with a bare #sso=ok
// marker (no token ever appears in a URL). MFA note: SSO logins do not repeat
// a TOTP challenge — step-up auth is the IdP's responsibility on that path.
//
// Account rules: a verified (issuer, subject) pair maps to exactly one user.
// First SSO login links by email to an existing user; unknown emails are
// rejected unless OIDC_AUTO_PROVISION=true (then created with
// OIDC_DEFAULT_ROLE, optionally fenced by OIDC_ALLOWED_EMAIL_DOMAINS).

import { Controller, Get, Inject, Logger, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { eq, and } from "drizzle-orm";
import { authIdentities, orgs, users } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { OidcService, type IdTokenClaims } from "./oidc.service";
import { issueSession, readCookie, type SessionUser } from "./session";

const TXN_COOKIE = "dental_sso_txn";

@Controller("auth/sso")
export class SsoController {
  private readonly log = new Logger("Sso");

  constructor(
    @Inject(DB) private db: Db,
    private oidc: OidcService,
    private audit: AuditService
  ) {}

  @Get("status")
  status() {
    const c = this.oidc.config();
    // issuerIsLocal lets the web hide the SSO button on hosted deploys when the
    // configured IdP is a localhost dev IdP (it would be unreachable for visitors).
    const issuerIsLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(c.issuer);
    return { enabled: this.oidc.enabled(), providerName: c.providerName, issuerIsLocal };
  }

  @Get("login")
  async login(@Res() res: Response) {
    const c = this.oidc.config();
    if (!this.oidc.enabled()) return res.redirect(`${c.webUrl}/login/sso#error=not_configured`);
    try {
      const { url, txn } = await this.oidc.buildAuthorizationUrl();
      res.cookie(TXN_COOKIE, this.oidc.signTransaction(txn), {
        httpOnly: true,
        sameSite: "lax",
        secure: c.redirectUri.startsWith("https"),
        maxAge: 600_000,
        path: "/auth/sso"
      });
      return res.redirect(url);
    } catch (e) {
      this.log.error(`SSO login init failed: ${(e as Error).message}`);
      return res.redirect(`${c.webUrl}/login/sso#error=idp_unreachable`);
    }
  }

  @Get("callback")
  async callback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("code") code?: string,
    @Query("state") state?: string,
    @Query("error") idpError?: string
  ) {
    const c = this.oidc.config();
    const fail = (reason: string) => {
      this.log.warn(`SSO callback rejected: ${reason}`);
      res.clearCookie(TXN_COOKIE, { path: "/auth/sso" });
      return res.redirect(`${c.webUrl}/login/sso#error=${encodeURIComponent(reason)}`);
    };

    if (idpError) return fail(`idp_${idpError}`);
    if (!code || !state) return fail("missing_code_or_state");

    const cookie = readCookie(req, TXN_COOKIE);
    if (!cookie) return fail("missing_transaction");
    let txn;
    try {
      txn = this.oidc.verifyTransaction(cookie);
    } catch {
      return fail("expired_transaction");
    }
    if (state !== txn.state) return fail("state_mismatch");

    let claims: IdTokenClaims;
    try {
      const idToken = await this.oidc.exchangeCode(code, txn.verifier);
      claims = await this.oidc.verifyIdToken(idToken, txn.nonce);
    } catch (e) {
      this.log.error(`SSO token exchange/verify failed: ${(e as Error).message}`);
      return fail("invalid_token");
    }

    const email = (claims.email ?? "").toLowerCase().trim();
    if (!email) return fail("no_email_claim");
    if (claims.email_verified === false) return fail("email_unverified");

    const user = await this.resolveUser(claims, email);
    if (typeof user === "string") return fail(user);
    if (user.disabledAt) return fail("account_disabled");

    const session: Omit<SessionUser, "csrf"> = {
      sub: user.id,
      orgId: user.orgId,
      email: user.email,
      name: user.name,
      role: user.role,
      locationId: user.locationId,
      providerSourceId: user.providerSourceId ?? null
    };
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "auth.sso.login", resource: "session", purpose: `oidc:${claims.iss}`
    });
    res.clearCookie(TXN_COOKIE, { path: "/auth/sso" });
    issueSession(res, session);
    return res.redirect(`${c.webUrl}/login/sso#sso=ok`);
  }

  // Returns the user row, or an error code string for the redirect.
  private async resolveUser(claims: IdTokenClaims, email: string) {
    const c = this.oidc.config();
    const [identity] = await this.db.select().from(authIdentities).where(and(
      eq(authIdentities.issuer, claims.iss),
      eq(authIdentities.subject, claims.sub)
    ));
    if (identity) {
      await this.db.update(authIdentities)
        .set({ lastLoginAt: new Date() })
        .where(eq(authIdentities.id, identity.id));
      const [user] = await this.db.select().from(users).where(eq(users.id, identity.userId));
      return user ?? "no_account";
    }

    let [user] = await this.db.select().from(users).where(eq(users.email, email));
    if (!user) {
      if (!c.autoProvision) return "no_account";
      const domain = email.split("@")[1] ?? "";
      if (c.allowedEmailDomains.length > 0 && !c.allowedEmailDomains.includes(domain)) {
        return "domain_not_allowed";
      }
      const [org] = await this.db.select().from(orgs).limit(1);
      if (!org) return "no_account";
      [user] = await this.db.insert(users).values({
        orgId: org.id,
        email,
        name: claims.name ?? email,
        role: c.defaultRole,
        locationId: null,
        passwordHash: null
      }).returning();
      await this.audit.log({
        orgId: org.id, actorType: "system", actor: "sso",
        action: "auth.sso.user_provisioned", resource: "user", resourceId: String(user.id),
        purpose: `oidc:${claims.iss}`
      });
    }

    await this.db.insert(authIdentities).values({
      userId: user.id,
      issuer: claims.iss,
      subject: claims.sub,
      email,
      lastLoginAt: new Date()
    });
    return user;
  }
}
