// F2: tamper-evident audit chain — the pure half (unit-tested; no DB).
// Each entry's hash commits to the previous entry's hash and a canonical
// JSON serialization of the entry's own fields, so any retroactive edit,
// deletion, or reordering breaks every hash after it.

import { createHash } from "node:crypto";

export interface ChainedAuditFields {
  orgId: number;
  locationId: number | null;
  actorType: string;
  actor: string;
  action: string;
  resource: string;
  resourceId: string;
  purpose: string;
  /** ISO-8601 with milliseconds — exactly what Date.toISOString() emits. */
  at: string;
}

// Canonical serialization: fixed key order, no whitespace variance. JSON.stringify
// with an explicit key array is deterministic across Node versions.
export function canonicalAuditJson(e: ChainedAuditFields): string {
  return JSON.stringify({
    orgId: e.orgId,
    locationId: e.locationId,
    actorType: e.actorType,
    actor: e.actor,
    action: e.action,
    resource: e.resource,
    resourceId: e.resourceId,
    purpose: e.purpose,
    at: e.at
  });
}

export function chainHash(prevHash: string, entry: ChainedAuditFields): string {
  return createHash("sha256")
    .update(prevHash)
    .update("\n")
    .update(canonicalAuditJson(entry))
    .digest("hex");
}
