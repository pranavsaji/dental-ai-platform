import { Injectable, Logger } from "@nestjs/common";
import { AuditService } from "../audit.service";
import type { EdgeSite } from "./edge-auth.guard";

// Reacts to canonical state transitions detected at ingest. Phase 3 wires
// this to Temporal (a scheduled appointment turning broken starts the
// cancellationBackfill workflow); until then it records the detection.
@Injectable()
export class HooksService {
  private readonly log = new Logger("Hooks");
  // Injected lazily by the Temporal module in Phase 3 to avoid a hard
  // dependency while the workflow engine is not yet part of the stack.
  onBrokenAppointment?: (site: EdgeSite, appointmentSourceId: number, payload: any) => Promise<void>;

  constructor(private audit: AuditService) {}

  async onAppointmentUpserted(
    site: EdgeSite,
    sourceId: number,
    prevStatus: string | null,
    payload: { status: string; startsAt: string; patientId: number }
  ): Promise<void> {
    const becameBroken = payload.status === "broken" && prevStatus !== null && prevStatus !== "broken";
    const inFuture = new Date(payload.startsAt) > new Date();
    if (!becameBroken || !inFuture) return;

    this.log.warn(`site ${site.siteKey}: appointment ${sourceId} became broken (was ${prevStatus})`);
    await this.audit.log({
      orgId: site.orgId,
      locationId: site.locationId,
      actorType: "edge",
      actor: `edge:${site.siteKey}`,
      action: "appointment.broken.detected",
      resource: "appointment",
      resourceId: String(sourceId),
      purpose: "slot backfill"
    });
    if (this.onBrokenAppointment) {
      await this.onBrokenAppointment(site, sourceId, payload);
    }
  }
}
