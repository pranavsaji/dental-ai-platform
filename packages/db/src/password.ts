import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Demo-grade credential hashing (scrypt, salt:hash hex). Production would use
// a managed IdP; this keeps the local stack dependency-free.

export function scryptHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function scryptVerify(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 32);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}
