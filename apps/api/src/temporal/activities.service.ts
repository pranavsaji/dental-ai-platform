import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import {
  appointments, claims, insPlans, patients, proposedActions, recalls
} from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CommandsService } from "../edge/commands.service";
import { TasksService } from "../portal/tasks.service";
import { SmsService } from "../sms/sms.service";
import { AgentsClient, type SchedulingCandidate } from "./agents.client";
import type { ActivitiesInterface, BackfillProposal, ProposeBackfillInput } from "./activities-types";

// Activity implementations: everything effectful the workflows need. Bound
// into the Temporal worker at startup.

@Injectable()
export class ActivitiesService implements ActivitiesInterface {
  private readonly log = new Logger("Activities");

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService,
    private commands: CommandsService,
    private tasks: TasksService,
    private sms: SmsService,
    private agents: AgentsClient
  ) {}

  // --- tasks (A5) ---------------------------------------------------------------

  async createTask(input: {
    orgId: number; locationId: number; type: string; title: string; body?: string;
    priority?: "low" | "normal" | "high" | "urgent"; assigneeRole?: string | null;
    createdBy: string; workflowId?: string | null;
    resourceType?: string | null; resourceId?: string | null;
  }): Promise<number> {
    return this.tasks.create(input);
  }

  async proposeBackfill(input: ProposeBackfillInput): Promise<BackfillProposal | null> {
    const today = new Date().toISOString().slice(0, 10);

    // Candidates: active patients overdue for recall, reachable by text, and
    // without an upcoming appointment already on the books.
    const upcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        sql`${appointments.startsAt} > now()`
      ));
    const rows = await this.db
      .select({
        patientSourceId: patients.sourceId,
        firstName: patients.firstName,
        lastName: patients.lastName,
        phone: patients.wirelessPhone,
        dateDue: recalls.dateDue,
        datePrevious: recalls.datePrevious
      })
      .from(recalls)
      .innerJoin(patients, and(
        eq(patients.locationId, recalls.locationId),
        eq(patients.sourceId, recalls.patientSourceId)
      ))
      .where(and(
        eq(recalls.locationId, input.locationId),
        eq(recalls.isDisabled, false),
        lt(recalls.dateDue, today),
        eq(patients.status, "active"),
        sql`${patients.wirelessPhone} <> ''`,
        notInArray(patients.sourceId, upcoming),
        sql`${patients.sourceId} <> ${input.cancelledPatientSourceId}`
      ))
      .orderBy(recalls.dateDue)
      .limit(5);

    if (rows.length === 0) {
      this.log.warn(`no backfill candidates at location ${input.locationId}`);
      return null;
    }

    const [cancelled] = await this.db
      .select({ firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.locationId, input.locationId), eq(patients.sourceId, input.cancelledPatientSourceId)));

    const candidates: SchedulingCandidate[] = rows.map((r) => ({
      patientSourceId: r.patientSourceId,
      name: `${r.firstName} ${r.lastName}`,
      phone: r.phone,
      overdueSince: r.dateDue,
      lastVisit: r.datePrevious
    }));

    const proposal = await this.agents.proposeScheduling({
      locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
      slot: { startsAt: input.startsAt, minutes: input.minutes, procDescript: input.procDescript },
      cancelledPatientName: cancelled ? `${cancelled.firstName} ${cancelled.lastName}` : "a patient",
      candidates
    });
    const chosen = candidates.find((c) => c.patientSourceId === proposal.patientSourceId)!;

    const when = new Date(input.startsAt).toLocaleString([], {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "scheduling",
      type: "backfill_outreach",
      summary:
        `Backfill the ${when} ${input.procDescript || "appointment"} slot (opened by a cancellation) ` +
        `by texting ${chosen.name}, overdue for recall since ${chosen.overdueSince}. ${proposal.rationale}`,
      payload: {
        message: proposal.message,
        patientSourceId: chosen.patientSourceId,
        patientName: chosen.name,
        slot: { startsAt: input.startsAt, minutes: input.minutes },
        usedLlm: proposal.usedLlm,
        candidates
      }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "agent.proposed.backfill_outreach",
      resource: "proposed_action", resourceId: String(action.id),
      purpose: `slot backfill for broken appointment ${input.appointmentSourceId}`
    });

    return {
      actionId: action.id,
      patientSourceId: chosen.patientSourceId,
      patientName: chosen.name,
      message: proposal.message
    };
  }

  async setActionStatus(actionId: number, status: string, decidedBy: string | null): Promise<void> {
    await this.db.update(proposedActions)
      .set({ status, decidedBy, decidedAt: new Date() })
      .where(eq(proposedActions.id, actionId));
  }

  async sendOutreachSms(input: {
    orgId: number; locationId: number; patientSourceId: number; body: string; workflowId: string;
  }): Promise<void> {
    await this.sms.send({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: input.patientSourceId,
      body: input.body,
      workflowId: input.workflowId,
      actor: "agent:scheduling",
      purpose: "approved outreach"
    });
  }

  async issueBookingCommand(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    providerSourceId: number; operatorySourceId: number; startsAt: string;
    minutes: number; procDescript: string;
  }): Promise<string> {
    return this.commands.issue(input.orgId, input.locationId, {
      type: "BookAppointment",
      patientSourceId: input.patientSourceId,
      providerSourceId: input.providerSourceId,
      operatorySourceId: input.operatorySourceId,
      startsAt: input.startsAt,
      minutes: input.minutes,
      procDescript: input.procDescript,
      note: `Booked by AI scheduling agent (workflow ${input.workflowId})`
    }, "agent:scheduling");
  }

  async getCommandStatus(commandId: string): Promise<string> {
    const row = await this.commands.getStatus(commandId);
    return row?.status ?? "missing";
  }

  async finalizeBackfill(input: {
    orgId: number; locationId: number; actionId: number; patientSourceId: number;
    workflowId: string; startsAt: string;
  }): Promise<void> {
    await this.setActionStatus(input.actionId, "executed", null);
    const when = new Date(input.startsAt).toLocaleString([], {
      weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    await this.sms.send({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: input.patientSourceId,
      body: `You're all set — see you ${when}. Reply CHANGE if you need to reschedule.`,
      workflowId: input.workflowId,
      actor: "agent:scheduling",
      purpose: "booking confirmation"
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "backfill.booked", resource: "patient",
      resourceId: String(input.patientSourceId), purpose: "slot backfill complete"
    });
    this.log.log(`backfill complete: patient ${input.patientSourceId} booked (workflow ${input.workflowId})`);
  }

  // --- billing: claim follow-up -----------------------------------------------

  async draftClaimFollowUp(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
  }): Promise<{ actionId: number; claimSourceId: number; patientSourceId: number; letter: string } | null> {
    const rows = await this.db
      .select({
        claimSourceId: claims.sourceId,
        patientSourceId: claims.patientSourceId,
        dateService: claims.dateService,
        dateSent: claims.dateSent,
        claimFee: claims.claimFee,
        insPayEst: claims.insPayEst,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        carrierName: insPlans.carrierName
      })
      .from(claims)
      .leftJoin(patients, and(
        eq(patients.locationId, claims.locationId),
        eq(patients.sourceId, claims.patientSourceId)))
      .leftJoin(insPlans, and(
        eq(insPlans.locationId, claims.locationId),
        eq(insPlans.sourceId, claims.planSourceId)))
      .where(and(eq(claims.locationId, input.locationId), inArray(claims.status, ["sent", "waiting"])))
      .orderBy(claims.dateSent)
      .limit(8);
    if (rows.length === 0) return null;

    const today = Date.now();
    const claimInputs = rows.map((r) => ({
      claimSourceId: r.claimSourceId,
      patientName: `${r.patientFirst ?? ""} ${r.patientLast ?? ""}`.trim() || "Unknown",
      carrierName: r.carrierName ?? "Unknown carrier",
      dateService: r.dateService,
      dateSent: r.dateSent,
      claimFee: r.claimFee,
      insPayEst: r.insPayEst,
      daysOutstanding: r.dateSent
        ? Math.floor((today - new Date(r.dateSent).getTime()) / 86_400_000)
        : 0
    }));

    const reviewResult = await this.agents.reviewClaims({
      locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
      claims: claimInputs
    });
    const chosen = claimInputs.find((c) => c.claimSourceId === reviewResult.claimSourceId) ?? claimInputs[0];
    const chosenRow = rows.find((r) => r.claimSourceId === chosen.claimSourceId)!;

    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "billing",
      type: "claim_followup",
      summary:
        `Chase the ${chosen.carrierName} claim for ${chosen.patientName} ` +
        `($${chosen.claimFee.toFixed(0)}, ${chosen.daysOutstanding} days outstanding). ${reviewResult.rationale}`,
      payload: { message: reviewResult.letter, claimSourceId: chosen.claimSourceId, claims: claimInputs }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "agent.proposed.claim_followup",
      resource: "claim", resourceId: String(chosen.claimSourceId), purpose: "revenue cycle"
    });
    return {
      actionId: action.id,
      claimSourceId: chosen.claimSourceId,
      patientSourceId: chosenRow.patientSourceId,
      letter: reviewResult.letter
    };
  }

  async recordClaimFollowUpSent(input: {
    orgId: number; locationId: number; patientSourceId: number; letter: string; workflowId: string;
  }): Promise<void> {
    await this.commands.issue(input.orgId, input.locationId, {
      type: "AddCommlog",
      patientSourceId: input.patientSourceId,
      note: `[AI billing agent] Claim follow-up sent to carrier:\n${input.letter}`,
      commType: 2,
      mode: 1,
      sentOrReceived: 1
    }, "agent:billing");
  }

  async checkClearinghouse(claimSourceId: number, attempt: number): Promise<"paid" | "denied" | "pending"> {
    // Mock clearinghouse: resolves probabilistically, more likely as attempts accrue.
    const roll = Math.random();
    if (roll < 0.05) return "denied";
    if (roll < 0.05 + Math.min(0.6, attempt * 0.12)) return "paid";
    this.log.log(`clearinghouse: claim ${claimSourceId} still pending (check ${attempt})`);
    return "pending";
  }

  async escalateClaim(input: {
    orgId: number; locationId: number; siteKey: string; claimSourceId: number;
    reason: string; workflowId: string;
  }): Promise<void> {
    await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "billing",
      type: "claim_escalation",
      summary: `Claim ${input.claimSourceId} needs human attention: ${input.reason}. Recommend calling the carrier.`,
      payload: { claimSourceId: input.claimSourceId, reason: input.reason }
    });
    // A5 retrofit: escalations also land in the durable task queue, proving
    // the pattern Phase B builds on (denials become assignable work, not
    // just a card that scrolls away).
    await this.tasks.create({
      orgId: input.orgId,
      locationId: input.locationId,
      type: "claim_denial",
      title: `Work denied/stalled claim ${input.claimSourceId}`,
      body: `${input.reason}. Recommend calling the carrier; see the escalation card for context.`,
      priority: "high",
      assigneeRole: "staff",
      createdBy: "agent:billing",
      workflowId: input.workflowId,
      resourceType: "claim",
      resourceId: String(input.claimSourceId)
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "claim.escalated", resource: "claim",
      resourceId: String(input.claimSourceId), purpose: input.reason
    });
  }

  // --- scheduling: recall campaign ---------------------------------------------

  async prepareRecallCampaign(input: {
    orgId: number; locationId: number; siteKey: string; batchSize: number; workflowId: string;
  }): Promise<{ actionId: number; recipients: Array<{ patientSourceId: number; message: string }> } | null> {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        sql`${appointments.startsAt} > now()`
      ));
    const rows = await this.db
      .select({
        patientSourceId: patients.sourceId,
        firstName: patients.firstName,
        dateDue: recalls.dateDue
      })
      .from(recalls)
      .innerJoin(patients, and(
        eq(patients.locationId, recalls.locationId),
        eq(patients.sourceId, recalls.patientSourceId)))
      .where(and(
        eq(recalls.locationId, input.locationId),
        eq(recalls.isDisabled, false),
        lt(recalls.dateDue, today),
        eq(patients.status, "active"),
        sql`${patients.wirelessPhone} <> ''`,
        notInArray(patients.sourceId, upcoming)
      ))
      .orderBy(recalls.dateDue)
      .limit(input.batchSize);
    if (rows.length === 0) return null;

    const site = `Lone Star Dental — site ${input.siteKey.toUpperCase()}`;
    const recipients = rows.map((r) => ({
      patientSourceId: r.patientSourceId,
      message:
        `Hi ${r.firstName}, this is ${site}. Our records show you've been due for a hygiene ` +
        `visit since ${r.dateDue}. Reply YES and we'll text you our next openings, or call us anytime.`
    }));

    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "scheduling",
      type: "recall_campaign",
      summary: `Reactivation sweep: text ${recipients.length} patients overdue for hygiene recall (oldest due ${rows[0].dateDue}).`,
      payload: { recipients, message: recipients[0]?.message }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "agent.proposed.recall_campaign",
      resource: "recall", resourceId: `${recipients.length} patients`, purpose: "reactivation"
    });
    return { actionId: action.id, recipients };
  }
}
