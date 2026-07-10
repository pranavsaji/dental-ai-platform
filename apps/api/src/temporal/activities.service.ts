import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  appointments, claimDenials, claims, commLogs, eligibilityChecks, huddleDigests,
  insPlans, locations, operatories, patPlans, patientContactPrefs, patients,
  payments, preauths, procedureCodes, procedures, proposedActions, recalls, smsMessages
} from "@dental/db";
import { classifyDenial, computeNoShowRisk } from "@dental/shared";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CommandsService } from "../edge/commands.service";
import { CLEARINGHOUSE, type ClearinghousePort } from "../clearinghouse";
import { TasksService } from "../portal/tasks.service";
import { SmsService } from "../sms/sms.service";
import { AgentsClient, type SchedulingCandidate } from "./agents.client";
import { findOpenSlots } from "./slots";
import type {
  ActivitiesInterface, BackfillCandidate, BackfillProposal, DenialRecord,
  EligibilitySweepItem, OutreachRecipient, PreauthCandidate, ProposeBackfillInput,
  ReminderRecipient, ReschedulePlan, SlotOffer
} from "./activities-types";

// Activity implementations: everything effectful the workflows need. Bound
// into the Temporal worker at startup.

@Injectable()
export class ActivitiesService implements ActivitiesInterface {
  private readonly log = new Logger("Activities");

  constructor(
    @Inject(DB) private db: Db,
    @Inject(CLEARINGHOUSE) private clearinghouse: ClearinghousePort,
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

    // C4 consumption: chronic no-shows stop getting first crack at open
    // slots. History feeds both the deterministic ordering and the agent
    // prompt (the agent may still weigh it differently within the list).
    const noShowByPatient = await this.priorNoShows(input.locationId, rows.map((r) => r.patientSourceId));

    const candidates: SchedulingCandidate[] = rows
      .map((r) => ({
        patientSourceId: r.patientSourceId,
        name: `${r.firstName} ${r.lastName}`,
        phone: r.phone,
        overdueSince: r.dateDue,
        lastVisit: r.datePrevious,
        priorNoShows: noShowByPatient.get(r.patientSourceId) ?? 0
      }))
      .sort((a, b) => (a.priorNoShows >= 2 ? 1 : 0) - (b.priorNoShows >= 2 ? 1 : 0));

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

    // C3 cascade: the agent's pick leads with its drafted message; the rest of
    // the ranked list follows with templates (cap 3 total). One approval
    // covers the batch — the workflow walks the list until someone books.
    const cascade: BackfillCandidate[] = [
      { patientSourceId: chosen.patientSourceId, patientName: chosen.name, message: proposal.message },
      ...candidates
        .filter((c) => c.patientSourceId !== chosen.patientSourceId)
        .slice(0, 2)
        .map((c) => ({
          patientSourceId: c.patientSourceId,
          patientName: c.name,
          message:
            `Hi ${c.name.split(" ")[0]}, this is Lone Star Dental — site ${input.siteKey.toUpperCase()}. ` +
            `An appointment just opened up on ${when} and you're due for a visit. ` +
            `Would you like it? Reply YES to book or NO to pass.`
        }))
    ];

    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "scheduling",
      type: "backfill_outreach",
      summary:
        `Backfill the ${when} ${input.procDescript || "appointment"} slot (opened by a cancellation) ` +
        `by texting ${chosen.name}, overdue for recall since ${chosen.overdueSince}. ${proposal.rationale} ` +
        `If they pass, the offer cascades to ${cascade.length - 1} more candidate${cascade.length === 2 ? "" : "s"}.`,
      payload: {
        message: proposal.message,
        patientSourceId: chosen.patientSourceId,
        patientName: chosen.name,
        slot: { startsAt: input.startsAt, minutes: input.minutes },
        usedLlm: proposal.usedLlm,
        cascade,
        candidates
      }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "agent.proposed.backfill_outreach",
      resource: "proposed_action", resourceId: String(action.id),
      purpose: `slot backfill for broken appointment ${input.appointmentSourceId}`
    });

    return { actionId: action.id, candidates: cascade };
  }

  /** Broken-with-no-show-note history per patient (C4 feature source). */
  private async priorNoShows(locationId: number, patientSourceIds: number[]): Promise<Map<number, number>> {
    if (patientSourceIds.length === 0) return new Map();
    const rows = await this.db
      .select({ patientSourceId: appointments.patientSourceId, n: sql<number>`count(*)::int` })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        inArray(appointments.patientSourceId, patientSourceIds),
        eq(appointments.status, "broken"),
        sql`${appointments.note} ilike '%no-show%'`
      ))
      .groupBy(appointments.patientSourceId);
    return new Map(rows.map((r) => [r.patientSourceId, r.n]));
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
    targetClaimSourceId?: number | null;
  }): Promise<{ actionId: number; claimSourceId: number; patientSourceId: number; letter: string } | null> {
    const scope = input.targetClaimSourceId
      ? and(eq(claims.locationId, input.locationId), eq(claims.sourceId, input.targetClaimSourceId))
      : and(eq(claims.locationId, input.locationId), inArray(claims.status, ["sent", "waiting"]));
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
      .where(scope)
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

  async checkClearinghouse(input: {
    locationId: number; claimSourceId: number; attempt: number;
  }): Promise<"paid" | "denied" | "pending"> {
    // B1: deterministic clearinghouse port replaces the old Math.random()
    // stub — same claim, same poll sequence, same outcome, every run.
    const [claim] = await this.db
      .select({ carcCodes: claims.carcCodes, dateSent: claims.dateSent })
      .from(claims)
      .where(and(eq(claims.locationId, input.locationId), eq(claims.sourceId, input.claimSourceId)));
    const daysOutstanding = claim?.dateSent
      ? Math.floor((Date.now() - new Date(claim.dateSent).getTime()) / 86_400_000)
      : 0;
    const res = await this.clearinghouse.checkClaimStatus({
      locationId: input.locationId,
      claimSourceId: input.claimSourceId,
      carcCodes: claim?.carcCodes ?? "",
      daysOutstanding,
      attempt: input.attempt
    });
    if (res.status === "paid" || res.status === "denied") return res.status;
    this.log.log(`clearinghouse: claim ${input.claimSourceId} ${res.status} (check ${input.attempt})`);
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

  // --- B2: insurance eligibility verification -----------------------------------

  async listEligibilitySweep(input: {
    orgId: number; locationId: number; daysAhead: number;
    appointmentSourceId?: number | null;
  }): Promise<EligibilitySweepItem[]> {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.daysAhead * 86_400_000);

    const apptScope = input.appointmentSourceId
      ? and(
          eq(appointments.locationId, input.locationId),
          eq(appointments.sourceId, input.appointmentSourceId))
      : and(
          eq(appointments.locationId, input.locationId),
          eq(appointments.status, "scheduled"),
          gte(appointments.startsAt, now),
          lte(appointments.startsAt, horizon));

    // One row per (patient, primary plan) on the upcoming schedule. Patients
    // without insurance simply don't appear (nothing to verify).
    const rows = await this.db
      .select({
        appointmentSourceId: appointments.sourceId,
        patientSourceId: appointments.patientSourceId,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        planSourceId: patPlans.planSourceId,
        carrierName: insPlans.carrierName,
        annualMax: insPlans.annualMax,
        deductible: insPlans.deductible
      })
      .from(appointments)
      .innerJoin(patients, and(
        eq(patients.locationId, appointments.locationId),
        eq(patients.sourceId, appointments.patientSourceId)))
      .innerJoin(patPlans, and(
        eq(patPlans.locationId, appointments.locationId),
        eq(patPlans.patientSourceId, appointments.patientSourceId),
        eq(patPlans.ordinal, 1)))
      .innerJoin(insPlans, and(
        eq(insPlans.locationId, patPlans.locationId),
        eq(insPlans.sourceId, patPlans.planSourceId)))
      .where(apptScope)
      .orderBy(appointments.startsAt)
      .limit(100);

    // Skip anyone with a live (unexpired, non-failed) check — checks are
    // fresh for 30 days, so the nightly sweep only touches new exposure.
    const fresh = await this.db
      .select({ patientSourceId: eligibilityChecks.patientSourceId, planSourceId: eligibilityChecks.planSourceId })
      .from(eligibilityChecks)
      .where(and(
        eq(eligibilityChecks.locationId, input.locationId),
        gt(eligibilityChecks.expiresAt, now),
        notInArray(eligibilityChecks.status, ["failed"])
      ));
    const freshKeys = new Set(fresh.map((f) => `${f.patientSourceId}:${f.planSourceId}`));

    const seen = new Set<string>();
    const items: EligibilitySweepItem[] = [];
    for (const r of rows) {
      const key = `${r.patientSourceId}:${r.planSourceId}`;
      if (seen.has(key) || freshKeys.has(key)) continue;
      seen.add(key);
      items.push({
        patientSourceId: r.patientSourceId,
        planSourceId: r.planSourceId,
        appointmentSourceId: r.appointmentSourceId,
        patientName: `${r.patientFirst} ${r.patientLast}`.trim(),
        carrierName: r.carrierName ?? "Unknown carrier",
        annualMax: r.annualMax ?? 0,
        deductible: r.deductible ?? 0
      });
    }
    return items;
  }

  async verifyEligibility(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    item: EligibilitySweepItem; attempt: number;
  }): Promise<"verified" | "attention" | "inactive" | "unavailable"> {
    const { item } = input;
    const res = await this.clearinghouse.checkEligibility({
      locationId: input.locationId,
      patientSourceId: item.patientSourceId,
      planSourceId: item.planSourceId,
      carrierName: item.carrierName,
      annualMax: item.annualMax,
      deductible: item.deductible,
      attempt: input.attempt
    });
    // Transient payer outage: no row yet — the workflow retries, and only a
    // final failure is recorded (recordEligibilityFailure).
    if (res.status === "unavailable") return "unavailable";

    const status =
      res.status === "inactive" ? "inactive" :
      res.frequencyFlags.length > 0 || res.annualMaxUsed / Math.max(1, res.annualMax) > 0.8
        ? "attention" : "verified";

    const { summary } = await this.agents.summarizeEligibility({
      patientName: item.patientName,
      carrierName: item.carrierName,
      status,
      deductibleRemaining: res.deductibleRemaining,
      annualMax: res.annualMax,
      annualMaxUsed: res.annualMaxUsed,
      frequencyFlags: res.frequencyFlags,
      payerNote: res.payerNote
    });

    const checkedAt = new Date();
    await this.db.insert(eligibilityChecks).values({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: item.patientSourceId,
      planSourceId: item.planSourceId,
      appointmentSourceId: item.appointmentSourceId,
      status,
      coverage: {
        deductibleRemaining: res.deductibleRemaining,
        annualMax: res.annualMax,
        annualMaxUsed: res.annualMaxUsed,
        frequencyFlags: res.frequencyFlags,
        payerNote: res.payerNote
      },
      summary,
      checkedAt,
      expiresAt: new Date(checkedAt.getTime() + 30 * 86_400_000),
      workflowId: input.workflowId
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: `eligibility.checked.${status}`, resource: "patient",
      resourceId: String(item.patientSourceId), purpose: `insurance verification (${item.carrierName})`
    });

    // Reds/ambers become durable, assignable work (A5) — the human surface.
    if (status === "inactive" || status === "attention") {
      await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "eligibility_failure",
        title: `${status === "inactive" ? "Coverage inactive" : "Eligibility needs attention"}: ${item.patientName} (${item.carrierName})`,
        body: summary,
        priority: status === "inactive" ? "high" : "normal",
        assigneeRole: "staff",
        createdBy: "agent:billing",
        workflowId: input.workflowId,
        resourceType: "patient",
        resourceId: String(item.patientSourceId)
      });
    }
    return status;
  }

  async recordEligibilityFailure(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    item: EligibilitySweepItem; attempts: number;
  }): Promise<void> {
    const { item } = input;
    const { summary } = await this.agents.summarizeEligibility({
      patientName: item.patientName, carrierName: item.carrierName, status: "failed",
      deductibleRemaining: 0, annualMax: 0, annualMaxUsed: 0, frequencyFlags: [], payerNote: ""
    });
    await this.db.insert(eligibilityChecks).values({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: item.patientSourceId,
      planSourceId: item.planSourceId,
      appointmentSourceId: item.appointmentSourceId,
      status: "failed",
      coverage: { attempts: input.attempts },
      summary,
      workflowId: input.workflowId
    });
    await this.tasks.create({
      orgId: input.orgId,
      locationId: input.locationId,
      type: "eligibility_failure",
      title: `Eligibility check failed: ${item.patientName} (${item.carrierName})`,
      body: `${summary} Verify by phone${item.carrierName !== "Unknown carrier" ? ` — carrier: ${item.carrierName}` : ""}.`,
      priority: "high",
      assigneeRole: "staff",
      createdBy: "agent:billing",
      workflowId: input.workflowId,
      resourceType: "patient",
      resourceId: String(item.patientSourceId)
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "eligibility.checked.failed", resource: "patient",
      resourceId: String(item.patientSourceId), purpose: `payer unavailable after ${input.attempts} attempts`
    });
  }

  // --- B3: pre-authorization -----------------------------------------------------

  async getPreauthCandidate(input: {
    orgId: number; locationId: number; procedureSourceId: number;
  }): Promise<PreauthCandidate | null> {
    const [proc] = await this.db
      .select({
        patientSourceId: procedures.patientSourceId,
        status: procedures.status,
        fee: procedures.fee,
        toothNum: procedures.toothNum,
        procDate: procedures.procDate,
        procCode: procedureCodes.procCode,
        description: procedureCodes.description,
        requiresPreauth: procedureCodes.requiresPreauth
      })
      .from(procedures)
      .leftJoin(procedureCodes, and(
        eq(procedureCodes.locationId, procedures.locationId),
        eq(procedureCodes.sourceId, procedures.codeSourceId)))
      .where(and(eq(procedures.locationId, input.locationId), eq(procedures.sourceId, input.procedureSourceId)));
    if (!proc || proc.status !== "planned" || !proc.requiresPreauth) return null;

    // Only fresh treatment plans start a pre-auth: the seeded aged backlog
    // (planned >7 days ago) belongs to C5 outreach, not a card storm here.
    if (proc.procDate && Date.now() - new Date(proc.procDate).getTime() > 7 * 86_400_000) return null;

    // Already open or resolved? The unique (location, procedure) row is the dedup.
    const [existing] = await this.db.select({ id: preauths.id }).from(preauths)
      .where(and(eq(preauths.locationId, input.locationId), eq(preauths.procedureSourceId, input.procedureSourceId)));
    if (existing) return null;

    const [coverage] = await this.db
      .select({
        planSourceId: patPlans.planSourceId,
        carrierName: insPlans.carrierName,
        patientFirst: patients.firstName,
        patientLast: patients.lastName
      })
      .from(patPlans)
      .leftJoin(insPlans, and(
        eq(insPlans.locationId, patPlans.locationId),
        eq(insPlans.sourceId, patPlans.planSourceId)))
      .leftJoin(patients, and(
        eq(patients.locationId, patPlans.locationId),
        eq(patients.sourceId, patPlans.patientSourceId)))
      .where(and(
        eq(patPlans.locationId, input.locationId),
        eq(patPlans.patientSourceId, proc.patientSourceId),
        eq(patPlans.ordinal, 1)));
    if (!coverage) return null; // uninsured — nothing to pre-authorize

    return {
      patientSourceId: proc.patientSourceId,
      patientName: `${coverage.patientFirst ?? ""} ${coverage.patientLast ?? ""}`.trim() || "Unknown",
      planSourceId: coverage.planSourceId,
      carrierName: coverage.carrierName ?? "Unknown carrier",
      procCode: proc.procCode ?? "",
      description: proc.description ?? "planned procedure",
      toothNum: proc.toothNum,
      fee: proc.fee
    };
  }

  async draftPreauth(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    procedureSourceId: number; candidate: PreauthCandidate;
  }): Promise<{ preauthId: number; actionId: number; narrative: string }> {
    const c = input.candidate;
    // Ground the narrative in the freshest chart notes (RAG-lite: the agent
    // cites note ids; the fallback template references them).
    const notes = await this.db
      .select({ id: commLogs.sourceId, note: commLogs.note })
      .from(commLogs)
      .where(and(eq(commLogs.locationId, input.locationId), eq(commLogs.patientSourceId, c.patientSourceId)))
      .orderBy(desc(commLogs.happenedAt))
      .limit(3);

    const draft = await this.agents.draftPreauth({
      locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
      patientName: c.patientName,
      carrierName: c.carrierName,
      procCode: c.procCode,
      description: c.description,
      toothNum: c.toothNum,
      fee: c.fee,
      notes: notes.map((n) => ({ id: n.id, note: n.note.slice(0, 400) }))
    });

    const [row] = await this.db.insert(preauths).values({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: c.patientSourceId,
      procedureSourceId: input.procedureSourceId,
      planSourceId: c.planSourceId,
      procCode: c.procCode,
      fee: c.fee,
      status: "pending_approval",
      narrative: draft.narrative,
      usedLlm: draft.usedLlm,
      workflowId: input.workflowId
    }).returning({ id: preauths.id });

    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "billing",
      type: "preauth_submission",
      summary:
        `Submit pre-authorization to ${c.carrierName} for ${c.patientName}: ${c.description} ` +
        `(${c.procCode}${c.toothNum ? `, tooth ${c.toothNum}` : ""}, $${c.fee.toFixed(0)}). ` +
        `Review the drafted clinical narrative before it goes to the payer.`,
      payload: {
        narrative: draft.narrative,
        preauthId: row.id,
        procedureSourceId: input.procedureSourceId,
        patientSourceId: c.patientSourceId,
        usedLlm: draft.usedLlm
      }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "agent.proposed.preauth_submission",
      resource: "preauth", resourceId: String(row.id),
      purpose: `${c.procCode} for patient ${c.patientSourceId}`
    });
    return { preauthId: row.id, actionId: action.id, narrative: draft.narrative };
  }

  async updatePreauthStatus(input: {
    orgId: number; locationId: number; preauthId: number; status: string;
    missingItem?: string; resolved?: boolean;
  }): Promise<void> {
    await this.db.update(preauths)
      .set({
        status: input.status,
        ...(input.missingItem !== undefined ? { missingItem: input.missingItem } : {}),
        ...(input.resolved ? { resolvedAt: new Date() } : {})
      })
      .where(and(eq(preauths.id, input.preauthId), eq(preauths.locationId, input.locationId)));
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "system",
      actor: "workflow:preAuthorization", action: `preauth.${input.status}`,
      resource: "preauth", resourceId: String(input.preauthId),
      purpose: input.missingItem || ""
    });
  }

  async submitPreauthToPayer(input: {
    orgId: number; locationId: number; preauthId: number; procedureSourceId: number;
    procCode: string; fee: number; narrative: string;
  }): Promise<string> {
    const ack = await this.clearinghouse.submitPreAuth({
      locationId: input.locationId,
      procedureSourceId: input.procedureSourceId,
      procCode: input.procCode,
      fee: input.fee,
      narrative: input.narrative
    });
    await this.db.update(preauths)
      .set({ status: "submitted", payerReference: ack.payerReference, submittedAt: new Date() })
      .where(and(eq(preauths.id, input.preauthId), eq(preauths.locationId, input.locationId)));
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "preauth.submitted", resource: "preauth",
      resourceId: String(input.preauthId), purpose: `payer ref ${ack.payerReference}`
    });
    return ack.payerReference;
  }

  async checkPreauthWithPayer(input: {
    locationId: number; procedureSourceId: number; attempt: number; afterMoreInfo: boolean;
  }): Promise<{ status: "pending" | "approved" | "more_info" | "denied"; missingItem: string; payerNote: string }> {
    return this.clearinghouse.checkPreAuthStatus(input);
  }

  async finalizePreauth(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    preauthId: number; procedureSourceId: number; patientSourceId: number;
    procCode: string; outcome: "approved" | "denied"; payerNote: string;
  }): Promise<void> {
    await this.db.update(preauths)
      .set({ status: input.outcome, resolvedAt: new Date() })
      .where(and(eq(preauths.id, input.preauthId), eq(preauths.locationId, input.locationId)));

    if (input.outcome === "approved") {
      // Write the authorization back to the PMS chart so the practice sees it
      // where they work — the same AddCommlog rail the follow-up letter uses.
      await this.commands.issue(input.orgId, input.locationId, {
        type: "AddCommlog",
        patientSourceId: input.patientSourceId,
        note: `[AI billing agent] Pre-authorization APPROVED for ${input.procCode} (preauth ${input.preauthId}). ${input.payerNote}`,
        commType: 2,
        mode: 1,
        sentOrReceived: 1
      }, "agent:billing");
    } else {
      await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "preauth_required",
        title: `Pre-auth denied: ${input.procCode} for patient ${input.patientSourceId}`,
        body: `${input.payerNote} Review alternatives with the provider or discuss self-pay options with the patient.`,
        priority: "high",
        assigneeRole: "staff",
        createdBy: "agent:billing",
        workflowId: input.workflowId,
        resourceType: "patient",
        resourceId: String(input.patientSourceId)
      });
    }
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: `preauth.${input.outcome}`, resource: "preauth",
      resourceId: String(input.preauthId), purpose: input.payerNote
    });
  }

  // --- B4: denial classification + appeal drafting -------------------------------

  async recordDenial(input: {
    orgId: number; locationId: number; siteKey: string; claimSourceId: number; workflowId: string;
  }): Promise<DenialRecord> {
    const [claim] = await this.db
      .select({
        patientSourceId: claims.patientSourceId,
        carcCodes: claims.carcCodes,
        claimFee: claims.claimFee,
        insPayEst: claims.insPayEst,
        dateService: claims.dateService,
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
      .where(and(eq(claims.locationId, input.locationId), eq(claims.sourceId, input.claimSourceId)));
    if (!claim) throw new Error(`claim ${input.claimSourceId} not found at location ${input.locationId}`);

    // The ERA is the source of truth for reason codes (~X12 835).
    const era = await this.clearinghouse.fetchRemittance({
      locationId: input.locationId,
      claimSourceId: input.claimSourceId,
      carcCodes: claim.carcCodes,
      claimFee: claim.claimFee,
      insPayEst: claim.insPayEst
    });
    const classification = classifyDenial(era.carcCodes);
    const patientName = `${claim.patientFirst ?? ""} ${claim.patientLast ?? ""}`.trim() || "Unknown";
    const carrierName = claim.carrierName ?? "Unknown carrier";

    const draft = await this.agents.draftAppeal({
      locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
      patientName,
      carrierName,
      claimSourceId: input.claimSourceId,
      dateService: claim.dateService,
      claimFee: claim.claimFee,
      carcCodes: era.carcCodes,
      category: classification.category,
      carcDescriptions: classification.descriptions
    });

    const carcJoined = era.carcCodes.join(",");
    const [row] = await this.db.insert(claimDenials).values({
      orgId: input.orgId,
      locationId: input.locationId,
      claimSourceId: input.claimSourceId,
      patientSourceId: claim.patientSourceId,
      carcCodes: carcJoined,
      category: classification.category,
      appealable: classification.appealable,
      agentSummary: draft.summary,
      appealLetter: classification.appealable ? draft.letter : "",
      usedLlm: draft.usedLlm,
      workflowId: input.workflowId
    }).onConflictDoUpdate({
      target: [claimDenials.locationId, claimDenials.claimSourceId],
      set: {
        carcCodes: carcJoined,
        category: classification.category,
        appealable: classification.appealable,
        agentSummary: draft.summary,
        workflowId: input.workflowId
      }
    }).returning({ id: claimDenials.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "denial.classified", resource: "claim",
      resourceId: String(input.claimSourceId),
      purpose: `${classification.category} (CARC ${carcJoined || "none"})`
    });

    // Non-appealable denials skip the appeal pipeline and go straight to a
    // task with a suggested patient-billing action.
    if (!classification.appealable) {
      await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "claim_denial",
        title: `Denial (${classification.category.replace(/_/g, " ")}): ${patientName} — ${carrierName}`,
        body: `${draft.summary} Not appealable — bill the patient portion or write off per policy.`,
        priority: "high",
        assigneeRole: "staff",
        createdBy: "agent:billing",
        workflowId: input.workflowId,
        resourceType: "patient",
        resourceId: String(claim.patientSourceId)
      });
    }

    return {
      denialId: row.id,
      patientSourceId: claim.patientSourceId,
      carcCodes: carcJoined,
      category: classification.category,
      appealable: classification.appealable,
      summary: draft.summary
    };
  }

  async draftAppeal(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    claimSourceId: number; denialId: number;
  }): Promise<{ actionId: number; letter: string }> {
    const [denial] = await this.db.select().from(claimDenials)
      .where(and(eq(claimDenials.id, input.denialId), eq(claimDenials.locationId, input.locationId)));
    if (!denial) throw new Error(`denial ${input.denialId} not found`);

    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "billing",
      type: "claim_appeal",
      summary:
        `Appeal the denied claim ${input.claimSourceId} ` +
        `(${denial.category.replace(/_/g, " ")}, CARC ${denial.carcCodes}). ` +
        `${denial.agentSummary} Review the drafted appeal letter before it is sent.`,
      payload: {
        letter: denial.appealLetter,
        denialId: denial.id,
        claimSourceId: input.claimSourceId,
        category: denial.category,
        carcCodes: denial.carcCodes,
        usedLlm: denial.usedLlm
      }
    }).returning({ id: proposedActions.id });

    await this.db.update(claimDenials)
      .set({ appealStatus: "pending_approval" })
      .where(eq(claimDenials.id, denial.id));

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "agent.proposed.claim_appeal",
      resource: "claim", resourceId: String(input.claimSourceId), purpose: denial.category
    });
    return { actionId: action.id, letter: denial.appealLetter };
  }

  async markAppealSent(input: {
    orgId: number; locationId: number; denialId: number; claimSourceId: number;
    patientSourceId: number; letter: string; workflowId: string;
  }): Promise<void> {
    await this.commands.issue(input.orgId, input.locationId, {
      type: "AddCommlog",
      patientSourceId: input.patientSourceId,
      note: `[AI billing agent] Appeal sent to carrier for claim ${input.claimSourceId}:\n${input.letter}`,
      commType: 2,
      mode: 1,
      sentOrReceived: 1
    }, "agent:billing");
    await this.db.update(claimDenials)
      .set({ appealStatus: "sent" })
      .where(and(eq(claimDenials.id, input.denialId), eq(claimDenials.locationId, input.locationId)));
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: "appeal.sent", resource: "claim",
      resourceId: String(input.claimSourceId), purpose: "denial appeal"
    });
  }

  async checkAppeal(input: {
    locationId: number; claimSourceId: number; attempt: number;
  }): Promise<"pending" | "won" | "lost"> {
    const res = await this.clearinghouse.checkAppealStatus(input);
    return res.status;
  }

  async resolveAppeal(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    denialId: number; claimSourceId: number; outcome: "won" | "lost" | "stalled";
  }): Promise<void> {
    const appealStatus = input.outcome === "stalled" ? "sent" : input.outcome;
    await this.db.update(claimDenials)
      .set({ appealStatus, ...(input.outcome !== "stalled" ? { resolvedAt: new Date() } : {}) })
      .where(and(eq(claimDenials.id, input.denialId), eq(claimDenials.locationId, input.locationId)));

    if (input.outcome !== "won") {
      const [denial] = await this.db.select({ patientSourceId: claimDenials.patientSourceId })
        .from(claimDenials).where(eq(claimDenials.id, input.denialId));
      await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "claim_denial",
        title: input.outcome === "lost"
          ? `Appeal lost — claim ${input.claimSourceId}`
          : `Appeal stalled — claim ${input.claimSourceId}`,
        body: input.outcome === "lost"
          ? "The payer upheld the denial. Bill the patient portion or write off per policy."
          : "No appeal determination after repeated checks. Call the carrier.",
        priority: "high",
        assigneeRole: "staff",
        createdBy: "agent:billing",
        workflowId: input.workflowId,
        resourceType: denial ? "patient" : null,
        resourceId: denial ? String(denial.patientSourceId) : null
      });
    }
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:billing", action: `appeal.${input.outcome}`, resource: "claim",
      resourceId: String(input.claimSourceId), purpose: "denial appeal outcome"
    });
  }

  // --- C4: no-show risk scoring ----------------------------------------------------

  async scoreNoShowRisk(input: {
    orgId: number; locationId: number; daysAhead: number;
  }): Promise<number> {
    const now = new Date();
    const horizon = new Date(now.getTime() + input.daysAhead * 86_400_000);
    const upcoming = await this.db
      .select({
        id: appointments.id,
        patientSourceId: appointments.patientSourceId,
        startsAt: appointments.startsAt,
        confirmed: appointments.confirmed,
        sourceStamp: appointments.sourceStamp
      })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, now),
        lte(appointments.startsAt, horizon)
      ));
    if (upcoming.length === 0) return 0;

    const patIds = [...new Set(upcoming.map((a) => a.patientSourceId))];
    const history = await this.db
      .select({
        patientSourceId: appointments.patientSourceId,
        status: appointments.status,
        note: appointments.note
      })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        inArray(appointments.patientSourceId, patIds),
        lt(appointments.startsAt, now)
      ));
    const firstVisits = await this.db
      .select({ sourceId: patients.sourceId, firstVisit: patients.firstVisit })
      .from(patients)
      .where(and(eq(patients.locationId, input.locationId), inArray(patients.sourceId, patIds)));
    const firstVisitByPat = new Map(firstVisits.map((p) => [p.sourceId, p.firstVisit]));

    const agg = new Map<number, { past: number; noShows: number; lateCancels: number }>();
    for (const h of history) {
      const a = agg.get(h.patientSourceId) ?? { past: 0, noShows: 0, lateCancels: 0 };
      a.past++;
      if (h.status === "broken") {
        if (/no-?show/i.test(h.note)) a.noShows++;
        else a.lateCancels++;
      }
      agg.set(h.patientSourceId, a);
    }

    for (const apt of upcoming) {
      const h = agg.get(apt.patientSourceId) ?? { past: 0, noShows: 0, lateCancels: 0 };
      const firstVisit = firstVisitByPat.get(apt.patientSourceId);
      const start = new Date(apt.startsAt);
      const score = computeNoShowRisk({
        pastAppointments: h.past,
        pastNoShows: h.noShows,
        priorLateCancels: h.lateCancels,
        confirmed: apt.confirmed,
        // Approximation: sourceStamp is the row's last PMS update, which for
        // untouched bookings is the booking time.
        leadTimeDays: Math.max(0, (start.getTime() - new Date(apt.sourceStamp).getTime()) / 86_400_000),
        isNewPatient: !firstVisit || now.getTime() - new Date(firstVisit).getTime() < 120 * 86_400_000,
        startHour: start.getHours(),
        dayOfWeek: start.getDay()
      });
      await this.db.update(appointments)
        .set({ noShowRisk: score.risk, noShowFactors: score.factors })
        .where(eq(appointments.id, apt.id));
    }
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "system",
      actor: "workflow:noShowRisk", action: "noshow.scored", resource: "schedule",
      resourceId: `${upcoming.length} appointments`, purpose: `next ${input.daysAhead} days`
    });
    return upcoming.length;
  }

  // --- C5: unscheduled-treatment outreach --------------------------------------------

  async prepareTreatmentOutreach(input: {
    orgId: number; locationId: number; siteKey: string; batchSize: number; workflowId: string;
  }): Promise<{ actionId: number; recipients: OutreachRecipient[] } | null> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 21 * 86_400_000).toISOString().slice(0, 10);

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
        procedureSourceId: procedures.sourceId,
        patientSourceId: procedures.patientSourceId,
        procDate: procedures.procDate,
        fee: procedures.fee,
        procCode: procedureCodes.procCode,
        description: procedureCodes.description,
        firstName: patients.firstName,
        lastName: patients.lastName,
        smsConsent: patientContactPrefs.smsConsent
      })
      .from(procedures)
      .innerJoin(patients, and(
        eq(patients.locationId, procedures.locationId),
        eq(patients.sourceId, procedures.patientSourceId)))
      .leftJoin(procedureCodes, and(
        eq(procedureCodes.locationId, procedures.locationId),
        eq(procedureCodes.sourceId, procedures.codeSourceId)))
      .leftJoin(patientContactPrefs, and(
        eq(patientContactPrefs.locationId, procedures.locationId),
        eq(patientContactPrefs.patientSourceId, procedures.patientSourceId)))
      .where(and(
        eq(procedures.locationId, input.locationId),
        eq(procedures.status, "planned"),
        lt(procedures.procDate, cutoff),
        gt(procedures.fee, 0),
        eq(patients.status, "active"),
        sql`${patients.wirelessPhone} <> ''`,
        notInArray(procedures.patientSourceId, upcoming)
      ))
      .limit(60);

    // Consent is enforced before anything is drafted (E1 will centralize this
    // in send(); until then the sweep is the gate). Missing prefs row = the
    // PMS mirror hasn't landed — treat as consent, same as the seed default.
    const consented = rows.filter((r) => r.smsConsent !== false);

    // Don't re-text anyone already in an outreach batch from the last 14 days.
    const recent = await this.db
      .select({ payload: proposedActions.payload })
      .from(proposedActions)
      .where(and(
        eq(proposedActions.locationId, input.locationId),
        eq(proposedActions.type, "treatment_outreach"),
        gt(proposedActions.createdAt, new Date(now.getTime() - 14 * 86_400_000))
      ));
    const recentlyContacted = new Set<number>();
    for (const a of recent) {
      for (const r of ((a.payload as any)?.recipients ?? [])) {
        if (r?.patientSourceId) recentlyContacted.add(Number(r.patientSourceId));
      }
    }

    // One procedure per patient (their highest-value plan), ranked fee × age.
    const byPatient = new Map<number, (typeof consented)[number]>();
    for (const r of consented) {
      if (recentlyContacted.has(r.patientSourceId)) continue;
      const cur = byPatient.get(r.patientSourceId);
      if (!cur || r.fee > cur.fee) byPatient.set(r.patientSourceId, r);
    }
    const ageDaysOf = (procDate: string | null) =>
      procDate ? Math.max(1, Math.floor((now.getTime() - new Date(procDate).getTime()) / 86_400_000)) : 1;
    const ranked = [...byPatient.values()]
      .sort((a, b) => b.fee * ageDaysOf(b.procDate) - a.fee * ageDaysOf(a.procDate))
      .slice(0, input.batchSize * 2);
    if (ranked.length === 0) return null;

    const site = `Lone Star Dental — site ${input.siteKey.toUpperCase()}`;
    const candidates = ranked.map((r) => ({
      patientSourceId: r.patientSourceId,
      name: `${r.firstName} ${r.lastName}`,
      procCode: r.procCode ?? "",
      description: r.description ?? "planned treatment",
      fee: r.fee,
      ageDays: ageDaysOf(r.procDate)
    }));

    // The agent refines the fee×age ranking with conversion judgment and
    // drafts the messages; the fallback keeps the deterministic order.
    const draft = await this.agents.draftTreatmentOutreach({
      locationName: site, batchSize: input.batchSize, candidates
    });

    const recipients: OutreachRecipient[] = [];
    for (const pick of draft.picks.slice(0, input.batchSize)) {
      const c = candidates.find((x) => x.patientSourceId === pick.patientSourceId);
      if (!c) continue; // agent may not invent recipients
      const r = ranked.find((x) => x.patientSourceId === c.patientSourceId)!;
      recipients.push({
        patientSourceId: c.patientSourceId,
        patientName: c.name,
        procedureSourceId: r.procedureSourceId,
        procCode: c.procCode,
        description: c.description,
        fee: c.fee,
        ageDays: c.ageDays,
        message: pick.message
      });
    }
    if (recipients.length === 0) return null;

    const value = recipients.reduce((s, r) => s + r.fee, 0);
    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "scheduling",
      type: "treatment_outreach",
      summary:
        `Unscheduled-treatment outreach: text ${recipients.length} patients with planned-but-unscheduled ` +
        `treatment worth $${value.toFixed(0)} (oldest plan ${Math.max(...recipients.map((r) => r.ageDays))} days). ` +
        `${draft.rationale} YES replies get 3 bookable time offers.`,
      payload: { recipients, usedLlm: draft.usedLlm }
    }).returning({ id: proposedActions.id });

    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "agent.proposed.treatment_outreach",
      resource: "proposed_action", resourceId: String(action.id),
      purpose: `${recipients.length} patients, $${value.toFixed(0)} at stake`
    });
    return { actionId: action.id, recipients };
  }

  // --- C2: reminders + confirmation write-back ----------------------------------------

  async listReminderCandidates(input: {
    orgId: number; locationId: number; siteKey: string;
  }): Promise<ReminderRecipient[]> {
    const dayStart = new Date();
    dayStart.setDate(dayStart.getDate() + 1);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const rows = await this.db
      .select({
        appointmentSourceId: appointments.sourceId,
        patientSourceId: appointments.patientSourceId,
        startsAt: appointments.startsAt,
        procDescript: appointments.procDescript,
        noShowRisk: appointments.noShowRisk,
        firstName: patients.firstName,
        lastName: patients.lastName,
        smsConsent: patientContactPrefs.smsConsent
      })
      .from(appointments)
      .innerJoin(patients, and(
        eq(patients.locationId, appointments.locationId),
        eq(patients.sourceId, appointments.patientSourceId)))
      .leftJoin(patientContactPrefs, and(
        eq(patientContactPrefs.locationId, appointments.locationId),
        eq(patientContactPrefs.patientSourceId, appointments.patientSourceId)))
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        eq(appointments.confirmed, false),
        gte(appointments.startsAt, dayStart),
        lte(appointments.startsAt, dayEnd),
        sql`${patients.wirelessPhone} <> ''`
      ))
      // C4 consumption: highest no-show risk gets reminded first, so the
      // riskiest patients have the longest window to confirm or reschedule.
      .orderBy(desc(appointments.noShowRisk), appointments.startsAt)
      .limit(50);
    const consented = rows.filter((r) => r.smsConsent !== false);
    if (consented.length === 0) return [];

    // Idempotence across manual re-runs: skip anyone a reminder workflow
    // already texted today (reminder workflow ids all start with 'remind').
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reminded = await this.db
      .select({ patientSourceId: smsMessages.patientSourceId })
      .from(smsMessages)
      .where(and(
        eq(smsMessages.locationId, input.locationId),
        eq(smsMessages.direction, "outbound"),
        gte(smsMessages.createdAt, today),
        sql`${smsMessages.workflowId} like 'remind%'`
      ));
    const alreadyReminded = new Set(reminded.map((r) => r.patientSourceId));

    const site = `Lone Star Dental — site ${input.siteKey.toUpperCase()}`;
    return consented
      .filter((r) => !alreadyReminded.has(r.patientSourceId))
      .map((r) => {
        const when = new Date(r.startsAt).toLocaleString([], { hour: "numeric", minute: "2-digit" });
        return {
          patientSourceId: r.patientSourceId,
          patientName: `${r.firstName} ${r.lastName}`,
          appointmentSourceId: r.appointmentSourceId,
          startsAt: new Date(r.startsAt).toISOString(),
          message:
            `Hi ${r.firstName}, a reminder from ${site}: you're scheduled tomorrow at ${when}` +
            `${r.procDescript ? ` (${r.procDescript})` : ""}. Reply C to confirm, ` +
            `CHANGE to reschedule, or STOP to opt out.`
        };
      });
  }

  async getReminderPolicy(input: { locationId: number }): Promise<{ autoSend: boolean }> {
    const [loc] = await this.db
      .select({ autoSendReminders: locations.autoSendReminders })
      .from(locations)
      .where(eq(locations.id, input.locationId));
    return { autoSend: loc?.autoSendReminders ?? false };
  }

  async prepareReminderBatch(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    recipients: ReminderRecipient[];
  }): Promise<{ actionId: number }> {
    const [action] = await this.db.insert(proposedActions).values({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: input.workflowId,
      agent: "scheduling",
      type: "reminder_batch",
      summary:
        `Send ${input.recipients.length} appointment reminder${input.recipients.length === 1 ? "" : "s"} ` +
        `for tomorrow's unconfirmed schedule. Replies of C confirm the appointment inside OpenDental. ` +
        `(Set the location's autoSendReminders policy to skip this card.)`,
      payload: { recipients: input.recipients, message: input.recipients[0]?.message }
    }).returning({ id: proposedActions.id });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling", action: "agent.proposed.reminder_batch",
      resource: "proposed_action", resourceId: String(action.id),
      purpose: `${input.recipients.length} unconfirmed appointments tomorrow`
    });
    return { actionId: action.id };
  }

  async confirmAppointment(input: {
    orgId: number; locationId: number; appointmentSourceId: number;
    patientSourceId: number; workflowId: string;
  }): Promise<"applied" | "failed"> {
    const commandId = await this.commands.issue(input.orgId, input.locationId, {
      type: "ConfirmAppointment",
      appointmentSourceId: input.appointmentSourceId
    }, "agent:scheduling");
    // The edge polls every few seconds; wait for the PMS ack within the
    // activity budget. A late apply still lands (the command stays queued) —
    // the canonical `confirmed` flag then updates on the next sync tick.
    let status = "pending";
    for (let i = 0; i < 30; i++) {
      status = (await this.commands.getStatus(commandId))?.status ?? "missing";
      if (status === "applied" || status === "failed") break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling",
      action: status === "applied" ? "appointment.confirmed" : "appointment.confirm_pending",
      resource: "appointment", resourceId: String(input.appointmentSourceId),
      purpose: `patient ${input.patientSourceId} replied to reminder`
    });
    return status === "applied" ? "applied" : "failed";
  }

  // --- C3: reschedule / slot-offer conversation ----------------------------------------

  async findSlotCandidates(input: {
    orgId: number; locationId: number; patientSourceId: number;
    appointmentSourceId?: number | null; procedureSourceId?: number | null;
  }): Promise<ReschedulePlan | null> {
    const [patient] = await this.db
      .select({ firstName: patients.firstName, lastName: patients.lastName })
      .from(patients)
      .where(and(eq(patients.locationId, input.locationId), eq(patients.sourceId, input.patientSourceId)));
    const patientName = patient ? `${patient.firstName} ${patient.lastName}` : `Patient ${input.patientSourceId}`;

    let providerSourceId: number;
    let operatorySourceId: number;
    let minutes = 60;
    let procDescript = "visit";
    let appointmentSourceId: number | null = null;

    if (input.appointmentSourceId) {
      const [apt] = await this.db.select().from(appointments)
        .where(and(
          eq(appointments.locationId, input.locationId),
          eq(appointments.sourceId, input.appointmentSourceId)));
      if (!apt || apt.status !== "scheduled") return this.rescheduleDeadEnd(input, patientName, "the appointment to move is no longer on the schedule");
      providerSourceId = apt.providerSourceId;
      operatorySourceId = apt.operatorySourceId;
      minutes = apt.minutes;
      procDescript = apt.procDescript || "visit";
      appointmentSourceId = apt.sourceId;
    } else if (input.procedureSourceId) {
      const [proc] = await this.db
        .select({
          providerSourceId: procedures.providerSourceId,
          description: procedureCodes.description
        })
        .from(procedures)
        .leftJoin(procedureCodes, and(
          eq(procedureCodes.locationId, procedures.locationId),
          eq(procedureCodes.sourceId, procedures.codeSourceId)))
        .where(and(
          eq(procedures.locationId, input.locationId),
          eq(procedures.sourceId, input.procedureSourceId)));
      if (!proc) return this.rescheduleDeadEnd(input, patientName, "the planned procedure could not be found");
      providerSourceId = proc.providerSourceId;
      procDescript = proc.description ?? "planned treatment";
      // Prefer the provider's home operatory; fall back to the first one.
      const ops = await this.db.select().from(operatories)
        .where(eq(operatories.locationId, input.locationId))
        .orderBy(operatories.itemOrder);
      operatorySourceId = (ops.find((o) => o.defaultProviderSourceId === providerSourceId) ?? ops[0])?.sourceId ?? 1;
    } else {
      // CHANGE with nothing to move and nothing planned — pick their next
      // scheduled appointment; if none, a human takes it from here.
      const [next] = await this.db.select().from(appointments)
        .where(and(
          eq(appointments.locationId, input.locationId),
          eq(appointments.patientSourceId, input.patientSourceId),
          eq(appointments.status, "scheduled"),
          sql`${appointments.startsAt} > now()`
        ))
        .orderBy(appointments.startsAt)
        .limit(1);
      if (!next) return this.rescheduleDeadEnd(input, patientName, "no upcoming appointment on the books");
      providerSourceId = next.providerSourceId;
      operatorySourceId = next.operatorySourceId;
      minutes = next.minutes;
      procDescript = next.procDescript || "visit";
      appointmentSourceId = next.sourceId;
    }

    const now = new Date();
    const busy = await this.db
      .select({
        startsAt: appointments.startsAt,
        minutes: appointments.minutes,
        operatorySourceId: appointments.operatorySourceId,
        providerSourceId: appointments.providerSourceId
      })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, now),
        lte(appointments.startsAt, new Date(now.getTime() + 15 * 86_400_000))
      ));

    // Deterministic like-for-like slot finder: same provider, ≤14 days out —
    // exactly the shape the auto-approve policy covers.
    const open = findOpenSlots(
      busy.map((b) => ({ ...b, startsAt: new Date(b.startsAt) })),
      { providerSourceId, operatorySourceId, minutes, from: now, days: 14, count: 3 }
    );
    if (open.length === 0) return this.rescheduleDeadEnd(input, patientName, "no open like-for-like slots in the next 14 days");

    // Local wall time, not toISOString(): the edge writes AptDateTime verbatim
    // into the PMS, and every sibling path (backfill, sim) speaks practice-local.
    const pad = (n: number) => String(n).padStart(2, "0");
    const localStamp = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    const slots: SlotOffer[] = open.map((s) => ({
      startsAt: localStamp(s.startsAt),
      minutes: s.minutes,
      operatorySourceId: s.operatorySourceId,
      providerSourceId: s.providerSourceId,
      label: s.startsAt.toLocaleString([], {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
      })
    }));
    return { patientSourceId: input.patientSourceId, patientName, appointmentSourceId, procDescript, slots };
  }

  private async rescheduleDeadEnd(
    input: { orgId: number; locationId: number; patientSourceId: number },
    patientName: string,
    reason: string
  ): Promise<null> {
    await this.tasks.create({
      orgId: input.orgId,
      locationId: input.locationId,
      type: "patient_question",
      title: `Scheduling request needs a human: ${patientName}`,
      body: `The patient asked to (re)schedule but the slot finder stopped: ${reason}. Call them to sort it out.`,
      priority: "normal",
      assigneeRole: "staff",
      createdBy: "agent:scheduling",
      resourceType: "patient",
      resourceId: String(input.patientSourceId)
    });
    return null;
  }

  async issueRescheduleCommands(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    appointmentSourceId: number | null; slot: SlotOffer; procDescript: string;
  }): Promise<{ bookingCommandId: string }> {
    // Break the old appointment first (reschedule mode); freeing the slot
    // deliberately lets the broken-appointment hook offer it to the backfill
    // cascade, same as any cancellation.
    if (input.appointmentSourceId) {
      await this.commands.issue(input.orgId, input.locationId, {
        type: "UpdateAppointmentStatus",
        appointmentSourceId: input.appointmentSourceId,
        status: "broken"
      }, "agent:scheduling");
    }
    const bookingCommandId = await this.commands.issue(input.orgId, input.locationId, {
      type: "BookAppointment",
      patientSourceId: input.patientSourceId,
      providerSourceId: input.slot.providerSourceId,
      operatorySourceId: input.slot.operatorySourceId,
      startsAt: input.slot.startsAt.slice(0, 19),
      minutes: input.slot.minutes,
      procDescript: input.procDescript,
      note: `Booked by AI scheduling agent (reschedule conversation ${input.workflowId})`
    }, "agent:scheduling");
    return { bookingCommandId };
  }

  async finalizeReschedule(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    appointmentSourceId: number | null; slot: SlotOffer; outcome: "booked" | "failed";
  }): Promise<void> {
    if (input.outcome === "failed") {
      await this.tasks.create({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "patient_question",
        title: `Reschedule booking failed for patient ${input.patientSourceId}`,
        body: `The PMS rejected the booking for ${input.slot.label}. Call the patient and book manually.`,
        priority: "high",
        assigneeRole: "staff",
        createdBy: "agent:scheduling",
        workflowId: input.workflowId,
        resourceType: "patient",
        resourceId: String(input.patientSourceId)
      });
    }
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:scheduling",
      action: input.outcome === "booked" ? "reschedule.booked" : "reschedule.failed",
      resource: "patient", resourceId: String(input.patientSourceId),
      purpose: input.appointmentSourceId
        ? `moved appointment ${input.appointmentSourceId} to ${input.slot.label} (auto-approved: like-for-like ≤14 days)`
        : `scheduled planned treatment for ${input.slot.label} (auto-approved: like-for-like ≤14 days)`
    });
  }

  // --- C1: morning huddle -----------------------------------------------------------

  async generateHuddleDigest(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
  }): Promise<{ date: string; actionCount: number; usedLlm: boolean }> {
    const now = new Date();
    // Local calendar dates throughout — the digest label must match the local
    // day the schedule facts were gathered for (toISOString would stamp a
    // late-evening run with tomorrow's UTC date).
    const pad = (n: number) => String(n).padStart(2, "0");
    const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const dateStr = localDate(now);
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);
    const yesterdayStr = localDate(new Date(dayStart.getTime() - 86_400_000));

    // Today's schedule + risk flags (C4 was refreshed by the workflow).
    const todays = await this.db
      .select({
        sourceId: appointments.sourceId,
        patientSourceId: appointments.patientSourceId,
        startsAt: appointments.startsAt,
        minutes: appointments.minutes,
        confirmed: appointments.confirmed,
        noShowRisk: appointments.noShowRisk,
        noShowFactors: appointments.noShowFactors,
        firstName: patients.firstName,
        lastName: patients.lastName
      })
      .from(appointments)
      .leftJoin(patients, and(
        eq(patients.locationId, appointments.locationId),
        eq(patients.sourceId, appointments.patientSourceId)))
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        gte(appointments.startsAt, dayStart),
        lte(appointments.startsAt, dayEnd)
      ))
      .orderBy(appointments.startsAt);
    const unconfirmed = todays.filter((a) => !a.confirmed).length;
    const highRisk = todays
      .filter((a) => a.noShowRisk >= 0.4)
      .sort((a, b) => b.noShowRisk - a.noShowRisk)
      .slice(0, 3)
      .map((a) => ({
        patientSourceId: a.patientSourceId,
        patientName: `${a.firstName ?? ""} ${a.lastName ?? ""}`.trim(),
        startsAt: new Date(a.startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        risk: a.noShowRisk,
        factors: ((a.noShowFactors as any[]) ?? []).map((f) => f.detail)
      }));

    // Open chair time vs. an 8h day across visible operatories.
    const ops = await this.db.select({ n: sql<number>`count(*)::int` }).from(operatories)
      .where(and(eq(operatories.locationId, input.locationId), eq(operatories.isHidden, false)));
    const capacityMin = (ops[0]?.n ?? 4) * 8 * 60;
    const bookedMin = todays.reduce((s, a) => s + a.minutes, 0);

    // Eligibility exceptions among today's patients (freshest check wins).
    const todayPatIds = [...new Set(todays.map((a) => a.patientSourceId))];
    let eligibilityGaps = 0;
    if (todayPatIds.length > 0) {
      const checks = await this.db
        .select({
          patientSourceId: eligibilityChecks.patientSourceId,
          status: eligibilityChecks.status,
          checkedAt: eligibilityChecks.checkedAt
        })
        .from(eligibilityChecks)
        .where(and(
          eq(eligibilityChecks.locationId, input.locationId),
          inArray(eligibilityChecks.patientSourceId, todayPatIds)
        ))
        .orderBy(desc(eligibilityChecks.checkedAt));
      const latest = new Map<number, string>();
      for (const c of checks) if (!latest.has(c.patientSourceId)) latest.set(c.patientSourceId, c.status);
      eligibilityGaps = todayPatIds.filter((id) => (latest.get(id) ?? "missing") !== "verified").length;
    }

    // Unscheduled treatment backlog (C5's inventory).
    const upcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, input.locationId),
        eq(appointments.status, "scheduled"),
        sql`${appointments.startsAt} > now()`
      ));
    const [unsched] = await this.db
      .select({ n: sql<number>`count(*)::int`, value: sql<number>`coalesce(sum(${procedures.fee}), 0)` })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, input.locationId),
        eq(procedures.status, "planned"),
        notInArray(procedures.patientSourceId, upcoming)
      ));

    // Claims needing action.
    const [claimAgg] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        value: sql<number>`coalesce(sum(${claims.claimFee} - ${claims.insPayAmt}), 0)`
      })
      .from(claims)
      .where(and(eq(claims.locationId, input.locationId), inArray(claims.status, ["sent", "waiting"])));
    const [denialAgg] = await this.db
      .select({ n: sql<number>`count(*) filter (where ${claimDenials.resolvedAt} is null)::int` })
      .from(claimDenials)
      .where(eq(claimDenials.locationId, input.locationId));
    const [preauthAgg] = await this.db
      .select({ n: sql<number>`count(*) filter (where ${preauths.status} = 'more_info')::int` })
      .from(preauths)
      .where(eq(preauths.locationId, input.locationId));

    // Yesterday's numbers, straight from canonical tables.
    const [prod] = await this.db
      .select({ v: sql<number>`coalesce(sum(${procedures.fee}), 0)` })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, input.locationId),
        eq(procedures.status, "complete"),
        eq(procedures.procDate, yesterdayStr)
      ));
    const [coll] = await this.db
      .select({ v: sql<number>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(and(eq(payments.locationId, input.locationId), eq(payments.payDate, yesterdayStr)));

    const taskSummary = await this.tasks.summary(input.orgId, input.locationId);

    const data = {
      date: dateStr,
      schedule: {
        appointments: todays.length,
        unconfirmed,
        firstStart: todays[0] ? new Date(todays[0].startsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null,
        openChairMinutes: Math.max(0, capacityMin - bookedMin),
        chairUtilization: capacityMin > 0 ? Math.round((bookedMin / capacityMin) * 100) / 100 : 0,
        highRisk
      },
      eligibilityGaps,
      unscheduledTreatment: { count: unsched?.n ?? 0, value: Math.round(unsched?.value ?? 0) },
      claims: {
        open: claimAgg?.n ?? 0,
        openValue: Math.round(claimAgg?.value ?? 0),
        openDenials: denialAgg?.n ?? 0,
        preauthsNeedingInfo: preauthAgg?.n ?? 0
      },
      yesterday: { production: Math.round(prod?.v ?? 0), collections: Math.round(coll?.v ?? 0) },
      tasks: { open: taskSummary.open, urgent: taskSummary.urgent }
    };

    const draft = await this.agents.draftHuddle({
      locationName: `Lone Star Dental — site ${input.siteKey.toUpperCase()}`,
      date: dateStr,
      data
    });

    await this.db.insert(huddleDigests).values({
      orgId: input.orgId,
      locationId: input.locationId,
      date: dateStr,
      narrative: draft.narrative,
      data,
      actionItems: draft.actions,
      usedLlm: draft.usedLlm,
      workflowId: input.workflowId
    }).onConflictDoUpdate({
      target: [huddleDigests.locationId, huddleDigests.date],
      set: {
        narrative: draft.narrative,
        data,
        actionItems: draft.actions,
        usedLlm: draft.usedLlm,
        workflowId: input.workflowId,
        createdAt: new Date()
      }
    });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId, actorType: "agent",
      actor: "agent:huddle", action: "huddle.ready", resource: "huddle_digest",
      resourceId: dateStr, purpose: `${todays.length} appointments, ${draft.actions.length} action items`
    });
    return { date: dateStr, actionCount: draft.actions.length, usedLlm: draft.usedLlm };
  }
}
