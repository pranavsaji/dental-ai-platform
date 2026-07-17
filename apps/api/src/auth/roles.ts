// RBAC policy. Every portal endpoint states its policy with an assertCan()
// (or assertRole for admin-only surfaces) — RBAC is a declaration you can
// grep, not the absence of a check. The single source of truth is POLICY
// below; the per-role intent:
//
//   admin    — the owner. Everything, org-wide: all locations, analytics /
//              revenue dashboards, audit trail, user + location management.
//   provider — a doctor. Their own schedule and their own patients (scoped
//              via users.provider_source_id -> appointments/patients rows),
//              clinical AI, tasks, huddle. No billing suite, no org
//              analytics, no audit, no admin.
//   billing  — insurance/RCM. The billing worklists (claims, denials,
//              pre-auths, payments ledger, eligibility), statements and
//              claim follow-ups, patient lookup for account context. No
//              campaign sends, no admin.
//   staff    — front desk. The whole schedule and patient roster for their
//              location, approvals, comms console, campaign triggers. No
//              billing ledger, no analytics, no audit.
//
// Data scoping (which rows within an allowed surface) lives in
// portal.service.ts: org from the JWT, location pinning via
// resolveLocation(), per-provider scoping via providerScopeOf().

import { ForbiddenException } from "@nestjs/common";
import type { SessionUser } from "./session";

export type Role = "admin" | "provider" | "billing" | "staff";

/** Every authenticated portal role — the explicit "anyone in-location" gate. */
export const ALL_ROLES: readonly Role[] = ["admin", "provider", "billing", "staff"];

export const POLICY = {
  // clinical / operational surfaces (row-level provider scoping applies)
  "schedule.read": ["admin", "provider", "billing", "staff"],
  "patients.read": ["admin", "provider", "billing", "staff"],
  "clinical.ai": ["admin", "provider", "staff"], // previsit summary, chart search
  "huddle.run": ["admin", "provider", "staff"], // generate / email the digest
  // communications & the human approval gate
  "comms.read": ["admin", "billing", "staff"], // sms + email consoles
  "comms.simulate": ["admin", "staff"], // inbound SMS simulator
  "approvals.act": ["admin", "billing", "staff"], // queue read + approve/reject
  "campaigns.run": ["admin", "staff"], // recall / reminder / outreach triggers
  "tasks.act": ["admin", "provider", "billing", "staff"],
  // money
  "billing.read": ["admin", "billing"], // claims, denials, preauths, payments, AR
  "billing.act": ["admin", "billing"], // claim follow-up, eligibility sweep
  "statements.send": ["admin", "billing", "staff"], // patient-facing balance notice
  "eligibility.read": ["admin", "provider", "billing", "staff"], // schedule badges
  // org / compliance
  "analytics.read": ["admin"], // org-wide revenue dashboards + insights
  "metrics.rollup": ["admin", "staff"], // 1-day recompute (the cron's job)
  "metrics.backfill": ["admin"], // multi-day: overwrites metric history
  "audit.read": ["admin"], // audit trail + chain verification
  "admin.manage": ["admin"] // users, location settings
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof POLICY;

export function can(user: SessionUser, permission: Permission): boolean {
  return (POLICY[permission] as readonly string[]).includes(user.role);
}

export function assertCan(user: SessionUser, permission: Permission): void {
  if (!can(user, permission)) {
    throw new ForbiddenException(
      `Requires ${POLICY[permission].join(" or ")} role for ${permission} (you are ${user.role})`
    );
  }
}

export function assertRole(user: SessionUser, ...roles: Role[]): void {
  if (!roles.includes(user.role as Role)) {
    throw new ForbiddenException(
      `Requires ${roles.join(" or ")} role (you are ${user.role})`
    );
  }
}
