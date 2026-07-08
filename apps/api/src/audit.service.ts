import { Inject, Injectable } from "@nestjs/common";
import { auditLog } from "@dental/db";
import { DB, type Db } from "./db";

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

// Append-only audit trail. Every PHI read/write path in the API calls this —
// the HIPAA story is that access is attributable, purposeful, and immutable.
@Injectable()
export class AuditService {
  constructor(@Inject(DB) private db: Db) {}

  async log(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      orgId: entry.orgId,
      locationId: entry.locationId ?? null,
      actorType: entry.actorType,
      actor: entry.actor,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId ?? "",
      purpose: entry.purpose ?? ""
    });
  }
}
