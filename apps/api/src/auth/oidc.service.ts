// OIDC relying party, provider-agnostic: any spec-compliant IdP (Google
// Workspace, Okta, Azure AD, or tools/dev-idp locally) works by setting
// OIDC_ISSUER / OIDC_CLIENT_ID / OIDC_CLIENT_SECRET. Authorization Code +
// PKCE; ID tokens are verified against the issuer's JWKS. The in-flight
// transaction (state, nonce, PKCE verifier) rides in a short-lived signed
// cookie so the API stays stateless.

import crypto from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import jwt from "jsonwebtoken";
import { JwksClient } from "jwks-rsa";

const JWT_SECRET = () => process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  providerName: string;
  autoProvision: boolean;
  allowedEmailDomains: string[]; // empty = any domain
  defaultRole: string;
  webUrl: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  email?: string;
  email_verified?: boolean;
  name?: string;
  nonce?: string;
}

export interface SsoTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

@Injectable()
export class OidcService {
  private readonly log = new Logger("Oidc");
  private discovery: Discovery | null = null;
  private discoveredAt = 0;
  private jwks: JwksClient | null = null;

  config(): OidcConfig {
    const apiUrl = process.env.API_URL ?? "http://localhost:4100";
    return {
      issuer: (process.env.OIDC_ISSUER ?? "").replace(/\/$/, ""),
      clientId: process.env.OIDC_CLIENT_ID ?? "",
      clientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
      redirectUri: process.env.OIDC_REDIRECT_URI ?? `${apiUrl}/auth/sso/callback`,
      scopes: process.env.OIDC_SCOPES ?? "openid email profile",
      providerName: process.env.OIDC_PROVIDER_NAME ?? "SSO",
      autoProvision: process.env.OIDC_AUTO_PROVISION === "true",
      allowedEmailDomains: (process.env.OIDC_ALLOWED_EMAIL_DOMAINS ?? "")
        .split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
      defaultRole: process.env.OIDC_DEFAULT_ROLE ?? "staff",
      webUrl: process.env.WEB_URL ?? "http://localhost:3000"
    };
  }

  enabled(): boolean {
    const c = this.config();
    return Boolean(c.issuer && c.clientId);
  }

  private async discover(): Promise<Discovery> {
    const c = this.config();
    if (this.discovery && Date.now() - this.discoveredAt < 3_600_000) return this.discovery;
    const res = await fetch(`${c.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status} from ${c.issuer}`);
    const doc = (await res.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
      throw new Error("OIDC discovery document missing required endpoints");
    }
    this.discovery = doc;
    this.discoveredAt = Date.now();
    this.jwks = new JwksClient({ jwksUri: doc.jwks_uri, cache: true, cacheMaxAge: 3_600_000 });
    return doc;
  }

  async buildAuthorizationUrl(): Promise<{ url: string; txn: SsoTransaction }> {
    const c = this.config();
    const disco = await this.discover();
    const txn: SsoTransaction = {
      state: b64url(crypto.randomBytes(24)),
      nonce: b64url(crypto.randomBytes(24)),
      verifier: b64url(crypto.randomBytes(48))
    };
    const challenge = b64url(crypto.createHash("sha256").update(txn.verifier).digest());
    const url = new URL(disco.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", c.clientId);
    url.searchParams.set("redirect_uri", c.redirectUri);
    url.searchParams.set("scope", c.scopes);
    url.searchParams.set("state", txn.state);
    url.searchParams.set("nonce", txn.nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), txn };
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const c = this.config();
    const disco = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: c.redirectUri,
      client_id: c.clientId,
      code_verifier: verifier
    });
    if (c.clientSecret) body.set("client_secret", c.clientSecret);
    const res = await fetch(disco.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`token exchange failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("token response missing id_token");
    return tokens.id_token;
  }

  async verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
    const c = this.config();
    const disco = await this.discover();
    const decoded = jwt.decode(idToken, { complete: true });
    if (!decoded || typeof decoded === "string") throw new Error("malformed id_token");
    const key = await this.jwks!.getSigningKey(decoded.header.kid);
    const claims = jwt.verify(idToken, key.getPublicKey(), {
      algorithms: ["RS256"],
      audience: c.clientId,
      issuer: disco.issuer
    }) as unknown as IdTokenClaims;
    if (!claims.nonce || claims.nonce !== expectedNonce) throw new Error("nonce mismatch");
    if (!claims.sub) throw new Error("id_token missing sub");
    return claims;
  }

  // The transaction cookie is itself a short-lived signed JWT, so a tampered
  // or replayed callback fails closed without any server-side session state.
  signTransaction(txn: SsoTransaction): string {
    return jwt.sign({ ...txn, use: "sso-txn" }, JWT_SECRET(), { expiresIn: "10m" });
  }

  verifyTransaction(cookieValue: string): SsoTransaction {
    const payload = jwt.verify(cookieValue, JWT_SECRET()) as jwt.JwtPayload;
    if (payload.use !== "sso-txn") throw new Error("wrong token type");
    return { state: payload.state, nonce: payload.nonce, verifier: payload.verifier };
  }
}
