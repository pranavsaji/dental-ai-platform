// F2: TOTP MFA helpers. The login flow never issues a session to an
// MFA-enrolled user without a valid code; the handoff between password step
// and code step is a short-lived, stage-scoped JWT (never a session).

import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { UnauthorizedException } from "@nestjs/common";
import { JWT_SECRET } from "./session";

export type MfaStage = "mfa" | "mfa_setup";

/**
 * Enforcement default: on in production, off in local dev (the demo logs in
 * with seeded creds); MFA_ENFORCE_ADMIN=true|false overrides either way.
 */
export function mfaEnforcedForAdmins(): boolean {
  const flag = (process.env.MFA_ENFORCE_ADMIN ?? "").toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function signMfaToken(userId: number, stage: MfaStage): string {
  return jwt.sign({ sub: userId, stage }, JWT_SECRET(), { expiresIn: "10m" });
}

export function verifyMfaToken(token: string, expected: MfaStage): number {
  let payload: { sub?: number; stage?: string };
  try {
    payload = jwt.verify(token, JWT_SECRET()) as typeof payload;
  } catch {
    throw new UnauthorizedException("MFA token expired or invalid — sign in again");
  }
  if (payload.stage !== expected || typeof payload.sub !== "number") {
    throw new UnauthorizedException("MFA token not valid for this step");
  }
  return payload.sub;
}

/** 8 one-time recovery codes, xxxx-xxxx. Plaintext is shown exactly once. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => {
    const hex = randomBytes(4).toString("hex");
    return `${hex.slice(0, 4)}-${hex.slice(4)}`;
  });
}
