import { describe, expect, it } from "vitest";
import { canonicalAuditJson, chainHash, type ChainedAuditFields } from "./audit-chain";

const entry = (over: Partial<ChainedAuditFields> = {}): ChainedAuditFields => ({
  orgId: 1,
  locationId: 2,
  actorType: "user",
  actor: "admin@dental.dev",
  action: "phi.read.schedule",
  resource: "schedule",
  resourceId: "2026-07-11",
  purpose: "operations",
  at: "2026-07-11T12:00:00.000Z",
  ...over
});

describe("audit hash chain (F2)", () => {
  it("is deterministic: same entry + same prev ⇒ same hash", () => {
    expect(chainHash("", entry())).toBe(chainHash("", entry()));
    expect(chainHash("abc", entry())).toBe(chainHash("abc", entry()));
  });

  it("canonical JSON has a fixed key order independent of input construction", () => {
    const a = canonicalAuditJson(entry());
    // Same fields, different property insertion order.
    const shuffled = entry();
    const b = canonicalAuditJson({
      at: shuffled.at, purpose: shuffled.purpose, resourceId: shuffled.resourceId,
      resource: shuffled.resource, action: shuffled.action, actor: shuffled.actor,
      actorType: shuffled.actorType, locationId: shuffled.locationId, orgId: shuffled.orgId
    });
    expect(a).toBe(b);
  });

  it("any field change changes the hash", () => {
    const base = chainHash("", entry());
    expect(chainHash("", entry({ actor: "mallory@evil.dev" }))).not.toBe(base);
    expect(chainHash("", entry({ purpose: "tampered" }))).not.toBe(base);
    expect(chainHash("", entry({ at: "2026-07-11T12:00:00.001Z" }))).not.toBe(base);
    expect(chainHash("", entry({ locationId: null }))).not.toBe(base);
  });

  it("hash commits to the previous hash (reordering breaks the chain)", () => {
    const h1 = chainHash("", entry({ action: "one" }));
    const h2 = chainHash(h1, entry({ action: "two" }));
    // Same second entry chained to a different predecessor ⇒ different hash.
    expect(chainHash("", entry({ action: "two" }))).not.toBe(h2);
    expect(chainHash(h2, entry({ action: "one" }))).not.toBe(h2);
  });

  it("a full chain recomputes end to end", () => {
    const entries = [entry({ action: "a" }), entry({ action: "b" }), entry({ action: "c" })];
    let prev = "";
    const hashes = entries.map((e) => (prev = chainHash(prev, e)));
    // Re-walk: every link verifies.
    prev = "";
    entries.forEach((e, i) => {
      expect(chainHash(prev, e)).toBe(hashes[i]);
      prev = hashes[i];
    });
  });
});
