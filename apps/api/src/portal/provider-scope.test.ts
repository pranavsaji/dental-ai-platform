import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { providerScopeOf } from "./portal.service";
import type { SessionUser } from "../auth/session";

function user(role: string, providerSourceId: number | null | undefined): SessionUser {
  return {
    sub: 1, orgId: 1, email: "x@dental.dev", name: "x",
    role, locationId: 1, providerSourceId
  };
}

describe("providerScopeOf", () => {
  it("non-provider roles are unscoped", () => {
    for (const role of ["admin", "billing", "staff"]) {
      expect(providerScopeOf(user(role, null))).toBeNull();
      // a stray link on a non-provider role must not scope anything
      expect(providerScopeOf(user(role, 7))).toBeNull();
    }
  });

  it("a linked provider is scoped to their PMS provider id", () => {
    expect(providerScopeOf(user("provider", 3))).toBe(3);
  });

  it("fails closed for an unlinked provider account", () => {
    expect(() => providerScopeOf(user("provider", null))).toThrow(ForbiddenException);
    // stale pre-RBAC session tokens have no providerSourceId claim at all
    expect(() => providerScopeOf(user("provider", undefined))).toThrow(ForbiddenException);
  });
});
