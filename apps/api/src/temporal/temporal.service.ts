import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { HooksService } from "../edge/hooks.service";
import { ActivitiesService } from "./activities.service";
import type { EdgeSite } from "../edge/edge-auth.guard";

export const TASK_QUEUE = "dental-ops";

// Hosts both the Temporal client and an in-process worker (fine for a local
// stack; production would run workers as their own deployment). Wires the
// ingest hook so a broken appointment starts cancellationBackfill.
@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Temporal");
  client: Client | null = null;
  private worker: Worker | null = null;

  constructor(
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
          prepareRecallCampaign: this.activities.prepareRecallCampaign.bind(this.activities)
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

  async onModuleDestroy(): Promise<void> {
    this.worker?.shutdown();
  }
}
