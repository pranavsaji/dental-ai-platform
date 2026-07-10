import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { locations } from "@dental/db";
import { DB, type Db } from "../db";
import { HooksService } from "../edge/hooks.service";
import { ActivitiesService } from "./activities.service";
import type { EdgeSite } from "../edge/edge-auth.guard";

export const TASK_QUEUE = "dental-ops";

// Hosts both the Temporal client and an in-process worker (fine for a local
// stack; production would run workers as their own deployment). Wires the
// ingest hooks (broken appointment → backfill, new upcoming appointment →
// eligibility check, planned procedure → pre-auth) and registers the
// nightly per-location eligibility sweep cron (B2).
@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Temporal");
  client: Client | null = null;
  private worker: Worker | null = null;

  constructor(
    @Inject(DB) private db: Db,
    private hooks: HooksService,
    private activities: ActivitiesService
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.TEMPORAL_DISABLED === "1") {
      this.log.warn("TEMPORAL_DISABLED=1 — workflows off");
      return;
    }
    const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
    try {
      const connection = await Connection.connect({ address, connectTimeout: "5s" });
      this.client = new Client({ connection });

      const nativeConnection = await NativeConnection.connect({ address });
      this.worker = await Worker.create({
        connection: nativeConnection,
        taskQueue: TASK_QUEUE,
        workflowsPath: require.resolve("./workflows"),
        activities: {
          proposeBackfill: this.activities.proposeBackfill.bind(this.activities),
          setActionStatus: this.activities.setActionStatus.bind(this.activities),
          sendOutreachSms: this.activities.sendOutreachSms.bind(this.activities),
          issueBookingCommand: this.activities.issueBookingCommand.bind(this.activities),
          getCommandStatus: this.activities.getCommandStatus.bind(this.activities),
          finalizeBackfill: this.activities.finalizeBackfill.bind(this.activities),
          draftClaimFollowUp: this.activities.draftClaimFollowUp.bind(this.activities),
          recordClaimFollowUpSent: this.activities.recordClaimFollowUpSent.bind(this.activities),
          checkClearinghouse: this.activities.checkClearinghouse.bind(this.activities),
          escalateClaim: this.activities.escalateClaim.bind(this.activities),
          prepareRecallCampaign: this.activities.prepareRecallCampaign.bind(this.activities),
          createTask: this.activities.createTask.bind(this.activities),
          // B2: eligibility verification
          listEligibilitySweep: this.activities.listEligibilitySweep.bind(this.activities),
          verifyEligibility: this.activities.verifyEligibility.bind(this.activities),
          recordEligibilityFailure: this.activities.recordEligibilityFailure.bind(this.activities),
          // B3: pre-authorization
          getPreauthCandidate: this.activities.getPreauthCandidate.bind(this.activities),
          draftPreauth: this.activities.draftPreauth.bind(this.activities),
          updatePreauthStatus: this.activities.updatePreauthStatus.bind(this.activities),
          submitPreauthToPayer: this.activities.submitPreauthToPayer.bind(this.activities),
          checkPreauthWithPayer: this.activities.checkPreauthWithPayer.bind(this.activities),
          finalizePreauth: this.activities.finalizePreauth.bind(this.activities),
          // B4: denial management
          recordDenial: this.activities.recordDenial.bind(this.activities),
          draftAppeal: this.activities.draftAppeal.bind(this.activities),
          markAppealSent: this.activities.markAppealSent.bind(this.activities),
          checkAppeal: this.activities.checkAppeal.bind(this.activities),
          resolveAppeal: this.activities.resolveAppeal.bind(this.activities)
        }
      });
      void this.worker.run().catch((err) => this.log.error(`worker crashed: ${err.message}`));
      this.log.log(`connected to ${address}; worker polling '${TASK_QUEUE}'`);
    } catch (err) {
      this.log.error(`Temporal unavailable at ${address}: ${(err as Error).message}. Workflows disabled.`);
      return;
    }

    this.hooks.onBrokenAppointment = async (site, sourceId, payload) => {
      await this.startBackfill(site, sourceId, payload);
    };
    // B2: a newly booked near-term appointment gets a targeted eligibility
    // check. Deterministic id — one workflow per appointment, ever.
    this.hooks.onUpcomingAppointment = async (site, sourceId) => {
      await this.startIdempotent("insuranceVerification", `elig-${site.siteKey}-${sourceId}`, {
        orgId: site.orgId,
        locationId: site.locationId,
        siteKey: site.siteKey,
        appointmentSourceId: sourceId
      });
    };
    // B3: a treatment-planned procedure may need a payer pre-auth; the
    // workflow's first activity decides (code, coverage, freshness, dedup).
    this.hooks.onPlannedProcedure = async (site, sourceId) => {
      await this.startIdempotent("preAuthorization", `preauth-${site.siteKey}-${sourceId}`, {
        orgId: site.orgId,
        locationId: site.locationId,
        siteKey: site.siteKey,
        procedureSourceId: sourceId
      });
    };

    await this.ensureEligibilityCrons();
  }

  // Nightly per-location eligibility sweep (B2): first cron schedule in the
  // codebase. 05:00 server-local; a manual trigger exists at
  // POST /portal/ops/eligibility-sweep for demos and verification.
  private async ensureEligibilityCrons(): Promise<void> {
    if (!this.client) return;
    try {
      const locs = await this.db.select().from(locations);
      for (const loc of locs) {
        try {
          await this.client.workflow.start("insuranceVerification", {
            taskQueue: TASK_QUEUE,
            workflowId: `elig-sweep-${loc.key}`,
            cronSchedule: "0 5 * * *",
            args: [{ orgId: loc.orgId, locationId: loc.id, siteKey: loc.key, daysAhead: 3 }]
          });
          this.log.log(`registered nightly eligibility sweep for site ${loc.key}`);
        } catch (err) {
          if ((err as any).name === "WorkflowExecutionAlreadyStartedError" || (err as Error).message?.includes("already")) continue;
          this.log.error(`eligibility cron for site ${loc.key}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log.error(`could not register eligibility crons: ${(err as Error).message}`);
    }
  }

  private async startIdempotent(name: string, workflowId: string, arg: unknown): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.workflow.start(name, { taskQueue: TASK_QUEUE, workflowId, args: [arg] });
      this.log.log(`started ${name} (${workflowId})`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!(msg.includes("already") || (err as any).name === "WorkflowExecutionAlreadyStartedError")) {
        this.log.error(`failed to start ${workflowId}: ${msg}`);
      }
    }
  }

  async startBackfill(site: EdgeSite, appointmentSourceId: number, payload: any): Promise<void> {
    if (!this.client) return;
    // Deterministic id: the same broken appointment never spawns two
    // concurrent backfills (duplicate start is rejected while one runs).
    const workflowId = `backfill-${site.siteKey}-${appointmentSourceId}`;
    try {
      await this.client.workflow.start("cancellationBackfill", {
        taskQueue: TASK_QUEUE,
        workflowId,
        args: [{
          orgId: site.orgId,
          locationId: site.locationId,
          siteKey: site.siteKey,
          appointmentSourceId,
          cancelledPatientSourceId: payload.patientId,
          startsAt: payload.startsAt,
          minutes: payload.minutes,
          operatorySourceId: payload.operatoryId,
          providerSourceId: payload.providerId,
          procDescript: payload.procDescript ?? "opening"
        }]
      });
      this.log.log(`started ${workflowId}`);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("already") || (err as any).name === "WorkflowExecutionAlreadyStartedError") {
        this.log.warn(`${workflowId} already running`);
      } else {
        this.log.error(`failed to start ${workflowId}: ${msg}`);
      }
    }
  }

  async startWorkflow(name: string, workflowId: string, arg: unknown): Promise<void> {
    if (!this.client) throw new Error("Temporal not connected");
    await this.client.workflow.start(name, {
      taskQueue: TASK_QUEUE,
      workflowId,
      args: [arg]
    });
    this.log.log(`started ${name} (${workflowId})`);
  }

  async signalApproval(workflowId: string, decision: "approved" | "rejected", decidedBy: string): Promise<void> {
    if (!this.client) throw new Error("Temporal not connected");
    await this.client.workflow.getHandle(workflowId).signal("approval", { decision, decidedBy });
  }

  async signalSmsReply(workflowId: string, body: string): Promise<void> {
    if (!this.client) throw new Error("Temporal not connected");
    await this.client.workflow.getHandle(workflowId).signal("smsReply", { body });
  }

  // B3: resolving a task created by a parked workflow resumes that workflow.
  async signalTaskResolved(workflowId: string, taskId: number): Promise<void> {
    if (!this.client) throw new Error("Temporal not connected");
    await this.client.workflow.getHandle(workflowId).signal("taskResolved", { taskId });
  }

  async onModuleDestroy(): Promise<void> {
    this.worker?.shutdown();
  }
}
