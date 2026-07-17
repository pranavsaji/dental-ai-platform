// F2: httpOnly cookie sessions. The JWT moves out of localStorage into an
// httpOnly SameSite=Lax cookie the browser attaches automatically (XSS can no
// longer exfiltrate it); a paired non-httpOnly CSRF cookie implements the
// double-submit check — mutating requests must echo it in an X-CSRF-Token
// header, which cross-site attackers cannot read or set. Bearer tokens keep
// working for scripts/tools; CSRF only applies to cookie-authenticated calls
// (a Bearer header can't be attached cross-site, so it needs no CSRF token).

import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "dental_session";
export const CSRF_COOKIE = "dental_csrf";

export const JWT_SECRET = () => process.env.JWT_SECRET ?? "dev-jwt-secret-change-me";

export interface SessionUser {
  sub: number;
  orgId: number;
  email: string;
  name: string;
  role: string; // admin | provider | billing | staff
  locationId: number | null; // null = all locations in org
  /** For provider-role users: their PMS provider record (ProvNum) at their
   *  pinned location. Drives own-schedule / own-patients row scoping. */
  providerSourceId?: number | null;
  /** CSRF double-submit value bound into the token at issue time. */
  csrf?: string;
}

const secureCookies = () =>
  (process.env.WEB_URL ?? "").startsWith("https") || process.env.NODE_ENV === "production";

/** Sets the session + CSRF cookies and returns the signed token (for Bearer use). */
export function issueSession(res: Response, session: Omit<SessionUser, "csrf">): string {
  const csrf = randomBytes(16).toString("hex");
  const token = jwt.sign({ ...session, csrf }, JWT_SECRET(), { expiresIn: "12h" });
  const base = { sameSite: "lax" as const, secure: secureCookies(), path: "/", maxAge: 12 * 3600_000 };
  res.cookie(SESSION_COOKIE, token, { ...base, httpOnly: true });
  // Deliberately NOT httpOnly: the web app reads it to echo X-CSRF-Token.
  res.cookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
  return token;
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
}

export function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
