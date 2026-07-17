import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { ALL_ROLES, POLICY, assertCan, assertRole, can, type Permission, type Role } from "./roles";
import type { SessionUser } from "./session";

function user(role: string, extra: Partial<SessionUser> = {}): SessionUser {
  return {
    sub: 1, orgId: 1, email: `${role}@dental.dev`, name: role,
    role, locationId: null, providerSourceId: null, ...extra
  };
}

// The intended decision matrix, written out in full so any drive-by edit to
// POLICY that widens or narrows access fails a test and forces a review.
const EXPECTED: Record<Permission, Record<Role, boolean>> = {
  "schedule.read":    { admin: true, provider: true,  billing: true,  staff: true },
  "patients.read":    { admin: true, provider: true,  billing: true,  staff: true },
  "clinical.ai":      { admin: true, provider: true,  billing: false, staff: true },
  "huddle.run":       { admin: true, provider: true,  billing: false, staff: true },
  "comms.read":       { admin: true, provider: false, billing: true,  staff: true },
  "comms.simulate":   { admin: true, provider: false, billing: false, staff: true },
  "approvals.act":    { admin: true, provider: false, billing: true,  staff: true },
  "campaigns.run":    { admin: true, provider: false, billing: false, staff: true },
  "tasks.act":        { admin: true, provider: true,  billing: true,  staff: true },
  "billing.read":     { admin: true, provider: false, billing: true,  staff: false },
  "billing.act":      { admin: true, provider: false, billing: true,  staff: false },
  "statements.send":  { admin: true, provider: false, billing: true,  staff: true },
  "eligibility.read": { admin: true, provider: true,  billing: true,  staff: true },
  "analytics.read":   { admin: true, provider: false, billing: false, staff: false },
  "metrics.rollup":   { admin: true, provider: false, billing: false, staff: true },
  "metrics.backfill": { admin: true, provider: false, billing: false, staff: false },
  "audit.read":       { admin: true, provider: false, billing: false, staff: false },
  "admin.manage":     { admin: true, provider: false, billing: false, staff: false }
};

describe("RBAC policy matrix", () => {
  it("covers every declared permission", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(POLICY).sort());
  });

  for (const [permission, byRole] of Object.entries(EXPECTED) as [Permission, Record<Role, boolean>][]) {
    for (const role of ALL_ROLES) {
      it(`${permission}: ${role} → ${byRole[role] ? "allow" : "deny"}`, () => {
        expect(can(user(role), permission)).toBe(byRole[role]);
        if (byRole[role]) {
          expect(() => assertCan(user(role), permission)).not.toThrow();
        } else {
          expect(() => assertCan(user(role), permission)).toThrow(ForbiddenException);
        }
      });
    }
  }

  it("admin can do everything (the owner role)", () => {
    for (const permission of Object.keys(POLICY) as Permission[]) {
      expect(can(user("admin"), permission)).toBe(true);
    }
  });

  it("denies unknown roles everywhere", () => {
    for (const permission of Object.keys(POLICY) as Permission[]) {
      expect(can(user("superuser"), permission)).toBe(false);
      expect(() => assertCan(user("superuser"), permission)).toThrow(ForbiddenException);
    }
  });
});

describe("assertRole", () => {
  it("allows a listed role and rejects others", () => {
    expect(() => assertRole(user("admin"), "admin")).not.toThrow();
    expect(() => assertRole(user("billing"), "admin")).toThrow(ForbiddenException);
    expect(() => assertRole(user("billing"), "admin", "billing")).not.toThrow();
  });
});
