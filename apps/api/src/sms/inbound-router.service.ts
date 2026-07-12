import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { appointments, claims, patients, procedures } from "@dental/db";
import { DB, type Db } from "../db";
import { TemporalService } from "../temporal/temporal.service";
import { AgentsClient } from "../temporal/agents.client";
import { TasksService } from "../portal/tasks.service";
import { EventsService } from "../portal/events.service";
import { SmsService } from "./sms.service";
import { isOptOutMessage } from "./policy";

// Shared inbound routing for the SMS console simulator and the Twilio
// webhook. E2 completes the router the C3 keyword fast-path started:
//   1. STOP/UNSUBSCRIBE → sticky opt-out (E1) — terminal, nothing else runs;
//   2. keyword fast-path: CHANGE/RESCHEDULE starts a rescheduleConversation;
//   3. a RUNNING workflow that recently texted this patient gets the reply
//      as a signal (the pre-existing threading, now gated on liveness);
//   4. everything else — the texts that used to vanish — is intent-classified
//      (question | billing_question | reschedule | confirm | other; no-LLM
//      fallback says `other`) and becomes a patient_question task carrying an
//      agent-drafted suggested reply. Staff approve/edit and send it from
//      /tasks — the AI never free-texts a patient autonomously.
@Injectable()
export class InboundRouterService {
  private readonly log = new Logger("InboundRouter");

  constructor(
    @Inject(DB) private db: Db,
    private temporal: TemporalService,
    private agents: AgentsClient,
    private tasks: TasksService,
    private sms: SmsService,
    private events: EventsService
  ) {}

  async route(input: {
    orgId: number;
    locationId: number;
    siteKey: string;
    patientSourceId: number;
    body: string;
    lastWorkflowId: string | null;
  }): Promise<{ routedTo: string | null; startedReschedule: boolean; optedOut?: boolean; taskId?: number }> {
    const text = input.body.trim();

    // F1: every inbound text pings the bell (both entry points — console
    // simulator and Twilio webhook — funnel through here).
    await this.events.publish({
      orgId: input.orgId, locationId: input.locationId, type: "sms.received",
      title: `Text from patient ${input.patientSourceId}`,
      body: text.length > 120 ? `${text.slice(0, 117)}…` : text,
      resourceType: "patient", resourceId: String(input.patientSourceId)
    });

    // 1. E1: STOP is terminal — record the sticky opt-out and route nowhere.
    if (isOptOutMessage(text)) {
      await this.sms.optOut(input.orgId, input.locationId, input.patientSourceId);
      return { routedTo: "opt-out", startedReschedule: false, optedOut: true };
    }

    // 2. Keyword fast-path: CHANGE/RESCHEDULE → deterministic reschedule flow.
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

    // 3. Thread the reply onto the workflow that most recently texted the
    // patient — but only if it is still running; a signal into a completed
    // workflow silently vanishes, which is exactly the E2 gap.
    if (input.lastWorkflowId) {
      const running = await this.temporal.isWorkflowRunning(input.lastWorkflowId);
      if (running) {
        try {
          await this.temporal.signalSmsReply(input.lastWorkflowId, text, input.patientSourceId);
          return { routedTo: input.lastWorkflowId, startedReschedule };
        } catch {
          // fall through to classification — the message must land somewhere
        }
      }
    }
    if (startedReschedule) {
      // The reschedule workflow will text the slot menu; no task needed.
      return { routedTo: null, startedReschedule };
    }

    // 4. E2: no live conversation — classify and hand to a human with a draft.
    const taskId = await this.classifyToTask(input, text);
    return { routedTo: taskId ? `task-${taskId}` : null, startedReschedule, taskId };
  }

  /** Intent classification → patient_question task with a drafted reply. */
  private async classifyToTask(
    input: { orgId: number; locationId: number; siteKey: string; patientSourceId: number },
    text: string
  ): Promise<number | undefined> {
    try {
      const context = await this.patientContext(input.locationId, input.patientSourceId);
      const result = await this.agents.classifyIntent({
        message: text,
        patientName: context.patientName,
        locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
        nextAppointment: context.nextAppointment,
        lastVisit: context.lastVisit,
        openClaimsValue: context.openClaimsValue
      });
      const intentLabel = result.intent.replace(/_/g, " ");
      const taskId = await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "patient_question",
        title: `Text from ${context.patientName} needs a reply (${intentLabel})`,
        body: `Patient wrote: "${text}"`,
        priority: "normal",
        assigneeRole: "staff",
        createdBy: "agent:intent",
        resourceType: "patient",
        resourceId: String(input.patientSourceId),
        data: {
          channel: "sms",
          message: text,
          intent: result.intent,
          suggestedReply: result.suggestedReply,
          usedLlm: result.usedLlm
        }
      });
      this.log.log(`inbound from patient ${input.patientSourceId} classified ${result.intent} → task ${taskId}`);
      return taskId;
    } catch (err) {
      this.log.error(`intent routing failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Grounding facts for the drafted reply — only what the platform knows. */
  private async patientContext(locationId: number, patientSourceId: number) {
    const [pat] = await this.db
      .select({ firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.locationId, locationId), eq(patients.sourceId, patientSourceId)));
    const [next] = await this.db
      .select({ startsAt: appointments.startsAt })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        eq(appointments.patientSourceId, patientSourceId),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, new Date())
      ))
      .orderBy(appointments.startsAt)
      .limit(1);
    const [last] = await this.db
      .select({ procDate: procedures.procDate })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.patientSourceId, patientSourceId),
        eq(procedures.status, "complete")
      ))
      .orderBy(desc(procedures.procDate))
      .limit(1);
    const [ar] = await this.db
      .select({ value: sql<number>`coalesce(sum(${claims.claimFee} - ${claims.insPayAmt}), 0)::float` })
      .from(claims)
      .where(and(
        eq(claims.locationId, locationId),
        eq(claims.patientSourceId, patientSourceId),
        sql`${claims.status} in ('sent', 'waiting')`
      ));
    return {
      patientName: pat ? `${pat.firstName} ${pat.lastName}` : `patient ${patientSourceId}`,
      nextAppointment: next?.startsAt?.toISOString() ?? null,
      lastVisit: last?.procDate ?? null,
      openClaimsValue: Math.max(0, Math.round((ar?.value ?? 0) * 100) / 100)
    };
  }
}
