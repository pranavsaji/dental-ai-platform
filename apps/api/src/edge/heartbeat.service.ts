import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { locations } from "@dental/db";
import type { EdgeHeartbeat } from "@dental/shared";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import type { EdgeSite } from "./edge-auth.guard";

// Records edge heartbeats (A1) so the dashboard can show honest provenance:
// which adapter is actually serving each site, and whether fallback engaged.
@Injectable()
export class HeartbeatService {
  private readonly log = new Logger("Heartbeat");

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  async record(site: EdgeSite, hb: EdgeHeartbeat): Promise<void> {
    const [prev] = await this.db
      .select({ mode: locations.integrationMode, status: locations.integrationStatus })
      .from(locations)
      .where(eq(locations.id, site.locationId));

    await this.db.update(locations)
      .set({
        integrationMode: hb.activeMode,
        integrationStatus: hb.status,
        lastHeartbeatAt: new Date()
      })
      .where(eq(locations.id, site.locationId));

    // Audit transitions only (heartbeats arrive every few seconds).
    const changed = prev && (prev.mode !== hb.activeMode || prev.status !== hb.status);
    if (changed) {
      if (hb.status === "degraded") {
        this.log.warn(`site ${site.siteKey}: adapter degraded — ${hb.detail}`);
      } else {
        this.log.log(`site ${site.siteKey}: integration now ${hb.activeMode}/${hb.status}`);
      }
      await this.audit.log({
        orgId: site.orgId,
        locationId: site.locationId,
        actorType: "edge",
        actor: `edge:${site.siteKey}`,
        action: hb.status === "degraded" ? "edge.adapter.degraded" : "edge.adapter.recovered",
        resource: "location",
        resourceId: String(site.locationId),
        purpose: hb.detail || `active mode ${hb.activeMode} (configured ${hb.configuredMode})`
      });
    }
  }
}
