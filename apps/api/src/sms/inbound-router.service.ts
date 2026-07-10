import { Injectable, Logger } from "@nestjs/common";
import { TemporalService } from "../temporal/temporal.service";

// Shared inbound routing for the SMS console simulator and the Twilio
// webhook. Today it does two things, in order:
//   1. keyword fast-path: CHANGE/RESCHEDULE starts a rescheduleConversation
//      (C3) — this is the deterministic head of E2's future intent router;
//   2. threads the reply onto the workflow that most recently texted the
//      patient (the pre-existing behavior), now carrying patientSourceId so
//      batch workflows know who answered.
// The reschedule workflow id is deterministic per patient, so a duplicate
// CHANGE while one conversation is live is rejected by Temporal.
@Injectable()
export class InboundRouterService {
  private readonly log = new Logger("InboundRouter");

  constructor(private temporal: TemporalService) {}

  async route(input: {
    orgId: number;
    locationId: number;
    siteKey: string;
    patientSourceId: number;
    body: string;
    lastWorkflowId: string | null;
  }): Promise<{ routedTo: string | null; startedReschedule: boolean }> {
    const text = input.body.trim();
    let startedReschedule = false;

    if (/^\s*(change|reschedule)\b/i.test(text)) {
      const workflowId = `resched-${input.siteKey}-p${input.patientSourceId}`;
      try {
        await this.temporal.startWorkflow("rescheduleConversation", workflowId, {
          orgId: input.orgId,
          locationId: input.locationId,
          siteKey: input.siteKey,
          patientSourceId: input.patientSourceId
        });
        startedReschedule = true;
        this.log.log(`CHANGE from patient ${input.patientSourceId} → ${workflowId}`);
      } catch (err) {
        const msg = (err as Error).message ?? "";
        if (!(msg.includes("already") || (err as any).name === "WorkflowExecutionAlreadyStartedError")) {
          this.log.error(`could not start ${workflowId}: ${msg}`);
        }
      }
    }

    if (input.lastWorkflowId) {
      try {
        await this.temporal.signalSmsReply(input.lastWorkflowId, text, input.patientSourceId);
      } catch {
        // workflow may have completed/expired; the message is still recorded
      }
    }
    return { routedTo: input.lastWorkflowId, startedReschedule };
  }
}
