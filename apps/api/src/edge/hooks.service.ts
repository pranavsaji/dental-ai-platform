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
  // B2: a new near-term appointment should get its insurance verified.
  onUpcomingAppointment?: (site: EdgeSite, appointmentSourceId: number, payload: any) => Promise<void>;
  // B3: a treatment-planned procedure may need a payer pre-authorization.
  onPlannedProcedure?: (site: EdgeSite, procedureSourceId: number, payload: any) => Promise<void>;

  constructor(private audit: AuditService) {}

  async onAppointmentUpserted(
    site: EdgeSite,
    sourceId: number,
    prevStatus: string | null,
    payload: { status: string; startsAt: string; patientId: number }
  ): Promise<void> {
    const inFuture = new Date(payload.startsAt) > new Date();

    // B2 trigger: a newly created scheduled appointment inside the eligibility
    // sweep window (next 3 days) gets a targeted verification. The workflow
    // itself skips patients with a fresh check, so first-sync bursts are cheap.
    const isNew = prevStatus === null && payload.status === "scheduled";
    const soon = inFuture &&
      new Date(payload.startsAt).getTime() - Date.now() < 3 * 86_400_000;
    if (isNew && soon && this.onUpcomingAppointment) {
      await this.onUpcomingAppointment(site, sourceId, payload);
    }

    const becameBroken = payload.status === "broken" && prevStatus !== null && prevStatus !== "broken";
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

  async onProcedureUpserted(
    site: EdgeSite,
    sourceId: number,
    prevStatus: string | null,
    payload: { status: string; patientId: number; fee: number; codeId: number }
  ): Promise<void> {
    // B3 trigger: procedure arrives (or transitions) treatment-planned. The
    // preAuthorization workflow decides whether the code actually requires
    // pre-auth and dedupes on an open preauth — the hook stays dumb.
    const becamePlanned = payload.status === "planned" && prevStatus !== "planned";
    if (!becamePlanned || !this.onPlannedProcedure) return;
    await this.onPlannedProcedure(site, sourceId, payload);
  }
}
