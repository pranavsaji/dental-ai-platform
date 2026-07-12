import { Inject, Injectable } from "@nestjs/common";
import { asc, desc, ne, sql } from "drizzle-orm";
import { auditLog } from "@dental/db";
import { DB, type Db } from "./db";
import { chainHash, type ChainedAuditFields } from "./audit-chain";

export interface AuditEntry {
  orgId: number;
  locationId?: number | null;
  actorType: "user" | "agent" | "edge" | "system";
  actor: string;
  action: string;
  resource: string;
  resourceId?: string;
  purpose?: string;
}

export interface ChainVerification {
  ok: boolean;
  checked: number;
  /** First row whose hash does not recompute (or whose link is broken). */
  brokenAtId: number | null;
  detail: string;
  /** Chain head — log this anchor externally to pin the whole history. */
  anchor: { id: number; entryHash: string } | null;
}

// Append-only, tamper-evident audit trail (F2 hardening). Every PHI read/write
// path in the API calls log(); each row's entry_hash commits to the previous
// row's hash, so edits/deletions/reordering are detectable by verifyChain().
// Rows written before the chain existed carry entry_hash='' and sit before the
// chain's genesis row; verification covers the hashed suffix.
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private db: Db) {}

  async log(entry: AuditEntry): Promise<void> {
    // Serialize chain appends: concurrent writers would otherwise race on
    // prev_hash and fork the chain. Advisory xact lock = held to commit.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_chain'))`);
      const [last] = await tx
        .select({ entryHash: auditLog.entryHash })
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(1);
      const prevHash = last?.entryHash ?? "";
      const at = new Date();
      const fields: ChainedAuditFields = {
        orgId: entry.orgId,
        locationId: entry.locationId ?? null,
        actorType: entry.actorType,
        actor: entry.actor,
        action: entry.action,
        resource: entry.resource,
        resourceId: entry.resourceId ?? "",
        purpose: entry.purpose ?? "",
        at: at.toISOString()
      };
      await tx.insert(auditLog).values({
        ...fields,
        at, // explicit so the stored timestamp is exactly what was hashed
        prevHash,
        entryHash: chainHash(prevHash, fields)
      });
    });
  }

  /**
   * Recompute the chain from its genesis row (first row with a hash) forward.
   * O(n) full walk — fine at platform scale; `limit` bounds a spot-check to
   * the most recent N rows (their stored prev_hash links still bind them to
   * everything earlier).
   */
  async verifyChain(limit?: number): Promise<ChainVerification> {
    let rows;
    if (limit && limit > 0) {
      const recent = await this.db.select().from(auditLog)
        .where(ne(auditLog.entryHash, ""))
        .orderBy(desc(auditLog.id)).limit(limit);
      rows = recent.reverse();
    } else {
      rows = await this.db.select().from(auditLog)
        .where(ne(auditLog.entryHash, ""))
        .orderBy(asc(auditLog.id));
    }
    if (rows.length === 0) {
      return { ok: true, checked: 0, brokenAtId: null, detail: "chain is empty", anchor: null };
    }

    let prevHash = rows[0].prevHash; // genesis "" on a full walk; trusted link on a spot-check
    for (const row of rows) {
      if (row.prevHash !== prevHash) {
        return {
          ok: false, checked: rows.length, brokenAtId: row.id,
          detail: `row ${row.id}: prev_hash link broken (row deleted or reordered before it)`,
          anchor: null
        };
      }
      const expected = chainHash(row.prevHash, {
        orgId: row.orgId,
        locationId: row.locationId,
        actorType: row.actorType,
        actor: row.actor,
        action: row.action,
        resource: row.resource,
        resourceId: row.resourceId,
        purpose: row.purpose,
        at: row.at.toISOString()
      });
      if (expected !== row.entryHash) {
        return {
          ok: false, checked: rows.length, brokenAtId: row.id,
          detail: `row ${row.id}: entry_hash does not recompute (row contents modified)`,
          anchor: null
        };
      }
      prevHash = row.entryHash;
    }
    const head = rows[rows.length - 1];
    return {
      ok: true, checked: rows.length, brokenAtId: null,
      detail: `verified ${rows.length} entries${limit ? ` (most recent ${limit})` : ""}`,
      anchor: { id: head.id, entryHash: head.entryHash }
    };
  }
}
