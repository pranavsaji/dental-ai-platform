// G4: explicit role gates. Every mutating portal endpoint states its policy
// with an assertRole() call — even when the answer is "all roles" — so RBAC
// is a declaration you can grep, not the absence of a check. The decision
// matrix lives in detail-plan.md (Phase G record); summary:
//
//   patient-facing sends (statement email, task reply, campaign approvals,
//   manual sweeps/outreach)          → staff | provider | admin (front desk's job)
//   money-adjacent reads (billing,
//   payments ledger)                 → staff | provider | admin
//   org-wide analytics reads         → assertOrgWide (analytics.service.ts)
//   admin surfaces (users, location
//   settings)                        → admin
//   destructive/config (metrics
//   backfill overwriting history)    → admin

import { ForbiddenException } from "@nestjs/common";
import type { SessionUser } from "./session";

export type Role = "admin" | "provider" | "staff";

/** Every authenticated portal role — the explicit "anyone in-location" gate. */
export const ALL_ROLES: readonly Role[] = ["admin", "provider", "staff"];

export function assertRole(user: SessionUser, ...roles: Role[]): void {
  if (!roles.includes(user.role as Role)) {
    throw new ForbiddenException(
      `Requires ${roles.join(" or ")} role (you are ${user.role})`
    );
  }
}
