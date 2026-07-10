import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  appointments, claimDenials, claims, commLogs, eligibilityChecks, insPlans,
  patPlans, patients, preauths, procedureCodes, procedures, proposedActions, recalls
} from "@dental/db";
import { classifyDenial } from "@dental/shared";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CommandsService } from "../edge/commands.service";
import { CLEARINGHOUSE, type ClearinghousePort } from "../clearinghouse";
import { TasksService } from "../portal/tasks.service";
import { SmsService } from "../sms/sms.service";
import { AgentsClient, type SchedulingCandidate } from "./agents.client";
import type {
  ActivitiesInterface, BackfillProposal, DenialRecord, EligibilitySweepItem,
  PreauthCandidate, ProposeBackfillInput
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
}
