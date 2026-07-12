// Temporal workflow definitions. This file is bundled into Temporal's
// deterministic sandbox: only @temporalio/workflow imports allowed — no Nest,
// no DB, no network. All side effects happen in activities.

import {
  ParentClosePolicy, condition, defineSignal, proxyActivities, setHandler,
  sleep, startChild, workflowInfo
} from "@temporalio/workflow";
import type { ActivitiesInterface } from "./activities-types";

const acts = proxyActivities<ActivitiesInterface>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5, initialInterval: "2s", backoffCoefficient: 2 }
});

export type Approval = { decision: "approved" | "rejected"; decidedBy: string };
export const approvalSignal = defineSignal<[Approval]>("approval");
// C3: replies carry the sender so batch workflows (reminders, outreach,
// cascade) can tell WHO answered. patientSourceId is optional for
// compatibility with histories signalled before Phase C.
export type SmsReply = { body: string; patientSourceId?: number };
export const smsReplySignal = defineSignal<[SmsReply]>("smsReply");
// B3: a parked workflow resumes when the human resolves its blocking task
// (the tasks controller signals the task's workflowId on resolve).
export const taskResolvedSignal = defineSignal<[{ taskId: number }]>("taskResolved");

// Ref-holders so TypeScript doesn't narrow signal state to `never` across
// awaits (signals mutate from outside the workflow's control flow).
function approvalGate(): { value: Approval | null } {
  const ref: { value: Approval | null } = { value: null };
  setHandler(approvalSignal, (a) => { ref.value = a; });
  return ref;
}

// Non-narrowing read: after `ref.value = null` TypeScript would otherwise pin
// the type to null across the next await (signals mutate from outside).
function readApproval(ref: { value: Approval | null }): Approval | null {
  return ref.value;
}

function smsReplyGate(): { value: SmsReply | null } {
  const ref: { value: SmsReply | null } = { value: null };
  setHandler(smsReplySignal, (r) => { ref.value = r; });
  return ref;
}

function readReply(ref: { value: SmsReply | null }): SmsReply | null {
  return ref.value;
}

export interface BackfillInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  appointmentSourceId: number;
  cancelledPatientSourceId: number;
  startsAt: string;
  minutes: number;
  operatorySourceId: number;
  providerSourceId: number;
  procDescript: string;
}

// The flagship long-running dental operation: a chair just opened up.
//   detect -> agent proposes a RANKED candidate list -> human approves once
//   -> cascade: SMS each candidate in turn (4h window, cap 3) until one says
//   yes -> booking command -> write-back confirmed against OpenDental.
// C3 upgrade: the slot only dies after the whole approved list is exhausted.
export async function cancellationBackfill(input: BackfillInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();
  const smsReply = smsReplyGate();

  // 1. Ask the scheduling agent for a plan; parks a card in the approval queue.
  const proposal = await acts.proposeBackfill({ ...input, workflowId: wfId });
  if (!proposal) return "no-candidates";

  // 2. Human in the loop: one decision covers the ranked batch (24h window).
  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(proposal.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(proposal.actionId, "approved", approval.value!.decidedBy);

  // 3. Cascade through candidates. Replies are matched on patientSourceId so
  // a stale "YES" from an earlier candidate can't claim the current offer.
  for (const candidate of proposal.candidates) {
    smsReply.value = null;
    // E1: the policy gate may refuse this candidate (opt-out, caps) — cascade
    // straight to the next one instead of waiting 4h on a dead offer.
    const offer = await acts.sendOutreachSms({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: candidate.patientSourceId,
      body: candidate.message,
      workflowId: wfId,
      kind: "outreach"
    });
    if (offer === "blocked") continue;
    const replied = await condition(() => {
      const r = readReply(smsReply);
      return r !== null && (r.patientSourceId ?? candidate.patientSourceId) === candidate.patientSourceId;
    }, "4 hours");
    if (!replied) continue; // timed out — cascade to the next candidate

    const positive = /^\s*(y|yes|sure|ok|confirm)/i.test(readReply(smsReply)!.body);
    if (!positive) {
      await acts.sendOutreachSms({
        orgId: input.orgId,
        locationId: input.locationId,
        patientSourceId: candidate.patientSourceId,
        body: "No problem — we'll keep you on the list and reach out next time. Reply STOP to opt out.",
        workflowId: wfId,
        kind: "conversation"
      });
      continue;
    }

    // 4. Book it: durable command to the edge, confirmed by ack from OpenDental.
    const commandId = await acts.issueBookingCommand({
      orgId: input.orgId,
      locationId: input.locationId,
      workflowId: wfId,
      patientSourceId: candidate.patientSourceId,
      providerSourceId: input.providerSourceId,
      operatorySourceId: input.operatorySourceId,
      startsAt: input.startsAt,
      minutes: input.minutes,
      procDescript: input.procDescript
    });
    let status = "pending";
    for (let i = 0; i < 60; i++) {
      status = await acts.getCommandStatus(commandId);
      if (status === "applied" || status === "failed") break;
      await sleep("3 seconds");
    }
    if (status !== "applied") {
      await acts.setActionStatus(proposal.actionId, "failed", null);
      return "booking-failed";
    }
    await acts.finalizeBackfill({
      orgId: input.orgId,
      locationId: input.locationId,
      actionId: proposal.actionId,
      patientSourceId: candidate.patientSourceId,
      workflowId: wfId,
      startsAt: input.startsAt
    });
    return "booked";
  }

  // Every candidate declined or timed out — the slot dies with the list.
  await acts.setActionStatus(proposal.actionId, "expired", null);
  return "exhausted";
}

export interface ClaimFollowUpInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  // B5: per-claim "Follow up" button pins the workflow to one claim.
  targetClaimSourceId?: number | null;
}

// Billing: agent picks the worst aging claim (or is pointed at one) and drafts
// the carrier follow-up -> human approves -> follow-up recorded against the
// chart -> durable polling of the clearinghouse port until adjudicated.
// The denied branch is the B4 pipeline: remittance -> classification ->
// (appealable) drafted appeal -> approval -> send -> poll the appeal outcome;
// (non-appealable) a task with the suggested patient-billing action.
export async function claimFollowUp(input: ClaimFollowUpInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();

  const draft = await acts.draftClaimFollowUp({ ...input, workflowId: wfId });
  if (!draft) return "no-aging-claims";

  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(draft.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(draft.actionId, "approved", approval.value!.decidedBy);
  await acts.recordClaimFollowUpSent({
    orgId: input.orgId,
    locationId: input.locationId,
    patientSourceId: draft.patientSourceId,
    letter: draft.letter,
    workflowId: wfId
  });

  // Durable polling: the workflow (not a cron job) owns the claim until it
  // resolves. The clearinghouse port is deterministic per claim (B1).
  let adjudicated: "paid" | "denied" | null = null;
  for (let attempt = 1; attempt <= 20; attempt++) {
    const status = await acts.checkClearinghouse({
      locationId: input.locationId, claimSourceId: draft.claimSourceId, attempt
    });
    if (status === "paid" || status === "denied") { adjudicated = status; break; }
    await sleep("15 seconds"); // demo cadence; production would be daily timers
  }
  if (adjudicated === null) {
    await acts.escalateClaim({
      orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
      claimSourceId: draft.claimSourceId, reason: "no adjudication after 20 checks", workflowId: wfId
    });
    await acts.setActionStatus(draft.actionId, "executed", null);
    return "stalled-escalated";
  }
  if (adjudicated === "paid") {
    await acts.setActionStatus(draft.actionId, "executed", null);
    return "paid";
  }

  // --- B4: denied. Fetch the remittance, classify, and work the denial. ------
  await acts.setActionStatus(draft.actionId, "executed", null);
  const denial = await acts.recordDenial({
    orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
    claimSourceId: draft.claimSourceId, workflowId: wfId
  });
  if (!denial.appealable) return "denied-task"; // recordDenial already created the task

  const appeal = await acts.draftAppeal({
    orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
    workflowId: wfId, claimSourceId: draft.claimSourceId, denialId: denial.denialId
  });

  // Second human gate, same signal: reset the ref and wait for the appeal card.
  approval.value = null;
  const appealDecided = await condition(() => readApproval(approval) !== null, "24 hours");
  const appealDecision = readApproval(approval);
  if (!appealDecided || appealDecision?.decision !== "approved") {
    await acts.setActionStatus(appeal.actionId, appealDecided ? "rejected" : "expired", appealDecision?.decidedBy ?? null);
    return appealDecided ? "appeal-rejected" : "appeal-expired";
  }
  await acts.setActionStatus(appeal.actionId, "approved", appealDecision.decidedBy);
  await acts.markAppealSent({
    orgId: input.orgId, locationId: input.locationId, denialId: denial.denialId,
    claimSourceId: draft.claimSourceId, patientSourceId: denial.patientSourceId,
    letter: appeal.letter, workflowId: wfId
  });
  await acts.setActionStatus(appeal.actionId, "executed", null);

  for (let attempt = 1; attempt <= 20; attempt++) {
    const outcome = await acts.checkAppeal({
      locationId: input.locationId, claimSourceId: draft.claimSourceId, attempt
    });
    if (outcome !== "pending") {
      await acts.resolveAppeal({
        orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
        workflowId: wfId, denialId: denial.denialId, claimSourceId: draft.claimSourceId, outcome
      });
      return `appeal-${outcome}`;
    }
    await sleep("15 seconds"); // demo cadence
  }
  await acts.resolveAppeal({
    orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
    workflowId: wfId, denialId: denial.denialId, claimSourceId: draft.claimSourceId, outcome: "stalled"
  });
  return "appeal-stalled";
}

// --- B2: insurance eligibility verification -------------------------------------

export interface InsuranceVerificationInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  /** Sweep horizon in days (nightly cron uses 3). */
  daysAhead?: number;
  /** When set, verify only this appointment (ingest-hook trigger). */
  appointmentSourceId?: number | null;
}

// Front desk story: every patient on the upcoming schedule has a green/amber/
// red insurance badge before the huddle — and reds come with a task. Read-only
// with respect to the PMS; tasks are the human surface, so no approval gate.
export async function insuranceVerification(input: InsuranceVerificationInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const items = await acts.listEligibilitySweep({
    orgId: input.orgId,
    locationId: input.locationId,
    daysAhead: input.daysAhead ?? 3,
    appointmentSourceId: input.appointmentSourceId ?? null
  });
  if (items.length === 0) return "nothing-to-verify";

  let verified = 0, flagged = 0, failed = 0;
  for (const item of items) {
    let outcome: "verified" | "attention" | "inactive" | "unavailable" = "unavailable";
    // Transient payer outages get 3 durable tries before becoming a task
    // (demo cadence — production would space these over hours).
    for (let attempt = 1; attempt <= 3; attempt++) {
      outcome = await acts.verifyEligibility({
        orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
        workflowId: wfId, item, attempt
      });
      if (outcome !== "unavailable") break;
      if (attempt < 3) await sleep("30 seconds");
    }
    if (outcome === "unavailable") {
      await acts.recordEligibilityFailure({
        orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
        workflowId: wfId, item, attempts: 3
      });
      failed++;
    } else if (outcome === "verified") {
      verified++;
    } else {
      flagged++;
    }
  }
  return `verified-${verified}-flagged-${flagged}-failed-${failed}`;
}

// --- B3: pre-authorization -------------------------------------------------------

export interface PreAuthorizationInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  procedureSourceId: number;
}

// Billing story: a crown gets treatment-planned and the pre-auth starts
// itself; a human reviews the narrative before submission, and only hears
// about it again when the payer wants something or it resolves.
export async function preAuthorization(input: PreAuthorizationInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();
  const taskResolved: { value: { taskId: number } | null } = { value: null };
  setHandler(taskResolvedSignal, (t) => { taskResolved.value = t; });

  const candidate = await acts.getPreauthCandidate({
    orgId: input.orgId, locationId: input.locationId, procedureSourceId: input.procedureSourceId
  });
  if (!candidate) return "not-required";

  const draft = await acts.draftPreauth({
    orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
    workflowId: wfId, procedureSourceId: input.procedureSourceId, candidate
  });

  // Human reviews the clinical narrative before anything reaches the payer.
  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(draft.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    await acts.updatePreauthStatus({
      orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
      status: "draft", resolved: true
    });
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(draft.actionId, "approved", approval.value!.decidedBy);

  await acts.submitPreauthToPayer({
    orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
    procedureSourceId: input.procedureSourceId, procCode: candidate.procCode,
    fee: candidate.fee, narrative: draft.narrative
  });
  await acts.setActionStatus(draft.actionId, "executed", null);

  // Durable poll of payer review (24–72 simulated hours, compressed for demo);
  // a more_info response parks the workflow on a task-resolution signal.
  let afterMoreInfo = false;
  for (let attempt = 1; attempt <= 30; attempt++) {
    const res = await acts.checkPreauthWithPayer({
      locationId: input.locationId, procedureSourceId: input.procedureSourceId,
      attempt, afterMoreInfo
    });
    if (res.status === "pending") {
      await sleep("15 seconds"); // demo cadence; production would be daily timers
      continue;
    }
    if (res.status === "more_info" && !afterMoreInfo) {
      await acts.updatePreauthStatus({
        orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
        status: "more_info", missingItem: res.missingItem
      });
      await acts.createTask({
        orgId: input.orgId,
        locationId: input.locationId,
        type: "preauth_required",
        title: `Payer needs more info: ${res.missingItem} (${candidate.procCode}, ${candidate.patientName})`,
        body: `${res.payerNote} Attach the requested item, then resolve this task — the pre-auth resumes automatically.`,
        priority: "high",
        assigneeRole: "staff",
        createdBy: "agent:billing",
        workflowId: wfId,
        resourceType: "patient",
        resourceId: String(candidate.patientSourceId)
      });
      // Park until the practice resolves the task (cap: 14 days).
      const resumed = await condition(() => taskResolved.value !== null, "14 days");
      if (!resumed) {
        await acts.updatePreauthStatus({
          orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
          status: "more_info", resolved: true
        });
        return "stalled-more-info";
      }
      afterMoreInfo = true;
      await acts.updatePreauthStatus({
        orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
        status: "submitted"
      });
      continue;
    }
    // approved or denied (a second more_info after resupply counts as denied
    // to avoid an infinite payer loop; the mock never does this).
    const outcome = res.status === "approved" ? "approved" : "denied";
    await acts.finalizePreauth({
      orgId: input.orgId, locationId: input.locationId, siteKey: input.siteKey,
      workflowId: wfId, preauthId: draft.preauthId,
      procedureSourceId: input.procedureSourceId,
      patientSourceId: candidate.patientSourceId, procCode: candidate.procCode,
      outcome, payerNote: res.payerNote
    });
    return outcome;
  }
  await acts.updatePreauthStatus({
    orgId: input.orgId, locationId: input.locationId, preauthId: draft.preauthId,
    status: "submitted", resolved: true
  });
  return "stalled";
}

export interface RecallCampaignInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  batchSize: number;
}

// Scheduling: reactivation sweep over overdue recalls. One human approval for
// the batch, then rate-limited outreach — the long-running-loop pattern.
export async function recallCampaign(input: RecallCampaignInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();

  const plan = await acts.prepareRecallCampaign({ ...input, workflowId: wfId });
  if (!plan) return "no-overdue-recalls";

  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(plan.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(plan.actionId, "approved", approval.value!.decidedBy);

  // E3: channel-aware delivery — patients who prefer email get the recall
  // letter template; everyone else gets the SMS. E1 policy applies to both.
  let sent = 0, blocked = 0;
  for (const r of plan.recipients) {
    const outcome = await acts.sendRecallMessage({
      orgId: input.orgId,
      locationId: input.locationId,
      siteKey: input.siteKey,
      workflowId: wfId,
      recipient: r
    });
    if (outcome === "blocked") blocked++;
    else sent++;
    await sleep("2 seconds"); // rate limit between sends
  }
  await acts.setActionStatus(plan.actionId, "executed", null);
  return blocked > 0 ? `sent-${sent}-blocked-${blocked}` : `sent-${sent}`;
}

// --- C3: reschedule / slot-offer conversation --------------------------------------

export interface RescheduleInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  patientSourceId: number;
  /** Move this appointment (CHANGE reply / reschedule request). */
  appointmentSourceId?: number | null;
  /** Or: schedule this planned procedure (C5 outreach YES). */
  procedureSourceId?: number | null;
}

// "Reply CHANGE" finally does what the confirmation SMS promises. One
// workflow covers both modes: rescheduling an existing appointment (break old
// + book new) and scheduling planned treatment (book only). The slot finder
// is deterministic — no LLM anywhere in this conversation. Approval policy:
// like-for-like moves ≤14 days out auto-proceed (the slot finder only offers
// those); everything else lands on a task for staff.
export async function rescheduleConversation(input: RescheduleInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const smsReply = smsReplyGate();

  // On a dead end (no appointment, no slots) the activity creates the task
  // itself — it has the patient context the workflow lacks.
  const plan = await acts.findSlotCandidates({
    orgId: input.orgId,
    locationId: input.locationId,
    patientSourceId: input.patientSourceId,
    appointmentSourceId: input.appointmentSourceId ?? null,
    procedureSourceId: input.procedureSourceId ?? null
  });
  if (!plan || plan.slots.length === 0) return "no-slots";

  const menu = plan.slots.map((s, i) => `${i + 1}) ${s.label}`).join("  ");
  const nums = plan.slots.map((_, i) => String(i + 1));
  const choiceText = nums.length === 1 ? "1" : `${nums.slice(0, -1).join(", ")} or ${nums[nums.length - 1]}`;
  await acts.sendOutreachSms({
    orgId: input.orgId,
    locationId: input.locationId,
    patientSourceId: input.patientSourceId,
    body:
      `Hi ${plan.patientName.split(" ")[0]}, here are our next openings for your ` +
      `${plan.procDescript}: ${menu}. Reply ${choiceText} to book.`,
    workflowId: wfId,
    kind: "conversation" // the patient asked — replies are exempt from quiet hours/caps
  });

  // Parse the pick; one clarifying re-ask on ambiguity, then hand to a human.
  let choice: number | null = null;
  for (let ask = 0; ask < 2 && choice === null; ask++) {
    smsReply.value = null;
    const got = await condition(() => {
      const r = readReply(smsReply);
      return r !== null && (r.patientSourceId ?? input.patientSourceId) === input.patientSourceId;
    }, "4 hours");
    if (!got) break;
    const m = readReply(smsReply)!.body.trim().match(/^([1-3])\b/);
    if (m && Number(m[1]) <= plan.slots.length) {
      choice = Number(m[1]) - 1;
    } else if (ask === 0) {
      await acts.sendOutreachSms({
        orgId: input.orgId,
        locationId: input.locationId,
        patientSourceId: input.patientSourceId,
        body: `Sorry, I didn't catch that — just reply ${choiceText} to pick a time, and we'll take care of the rest.`,
        workflowId: wfId,
        kind: "conversation"
      });
    }
  }
  if (choice === null) {
    await acts.createTask({
      orgId: input.orgId,
      locationId: input.locationId,
      type: "patient_question",
      title: `Scheduling needs a human: ${plan.patientName}`,
      body: `Offered slots for ${plan.procDescript} (${menu}) but got no usable reply. Call the patient to finish scheduling.`,
      priority: "normal",
      assigneeRole: "staff",
      createdBy: "agent:scheduling",
      workflowId: wfId,
      resourceType: "patient",
      resourceId: String(input.patientSourceId)
    });
    return "handed-off";
  }

  const slot = plan.slots[choice];
  const { bookingCommandId } = await acts.issueRescheduleCommands({
    orgId: input.orgId,
    locationId: input.locationId,
    workflowId: wfId,
    patientSourceId: input.patientSourceId,
    appointmentSourceId: plan.appointmentSourceId,
    slot,
    procDescript: plan.procDescript
  });
  let status = "pending";
  for (let i = 0; i < 60; i++) {
    status = await acts.getCommandStatus(bookingCommandId);
    if (status === "applied" || status === "failed") break;
    await sleep("3 seconds");
  }
  if (status !== "applied") {
    await acts.finalizeReschedule({
      orgId: input.orgId, locationId: input.locationId, workflowId: wfId,
      patientSourceId: input.patientSourceId, appointmentSourceId: plan.appointmentSourceId,
      slot, outcome: "failed"
    });
    return "booking-failed";
  }
  await acts.sendOutreachSms({
    orgId: input.orgId,
    locationId: input.locationId,
    patientSourceId: input.patientSourceId,
    body: `You're all set — see you ${slot.label}. Reply CHANGE if you need to reschedule.`,
    workflowId: wfId,
    kind: "confirmation"
  });
  await acts.finalizeReschedule({
    orgId: input.orgId, locationId: input.locationId, workflowId: wfId,
    patientSourceId: input.patientSourceId, appointmentSourceId: plan.appointmentSourceId,
    slot, outcome: "booked"
  });
  return "booked";
}

// --- C5: unscheduled-treatment outreach ---------------------------------------------

export interface TreatmentOutreachInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  batchSize?: number;
}

// "Dr. Patel planned a crown 3 months ago and it never got scheduled." A thin
// feature over the proven backfill rails: rank the planned-unscheduled
// backlog by fee × age, one batch approval card, SMS outreach, and each YES
// hands off to a slot-offer conversation (C3) that books through the PMS.
export async function treatmentOutreach(input: TreatmentOutreachInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();
  const smsReply = smsReplyGate();

  const plan = await acts.prepareTreatmentOutreach({
    orgId: input.orgId,
    locationId: input.locationId,
    siteKey: input.siteKey,
    batchSize: input.batchSize ?? 5,
    workflowId: wfId
  });
  if (!plan) return "no-unscheduled-treatment";

  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(plan.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(plan.actionId, "approved", approval.value!.decidedBy);

  let delivered = 0;
  for (const r of plan.recipients) {
    const outcome = await acts.sendOutreachSms({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: r.patientSourceId,
      body: r.message,
      workflowId: wfId,
      kind: "outreach"
    });
    if (outcome !== "blocked") delivered++;
    await sleep("2 seconds"); // rate limit between texts
  }
  await acts.setActionStatus(plan.actionId, "executed", null);

  // Collect replies for the rest of the day; every YES spawns a detached
  // slot-offer child so the booking conversation outlives this sweep.
  const engaged = new Set<number>();
  const deadline = Date.now() + 8 * 3_600_000;
  while (Date.now() < deadline && engaged.size < plan.recipients.length) {
    smsReply.value = null;
    const got = await condition(() => readReply(smsReply) !== null, deadline - Date.now());
    if (!got) break;
    const reply = readReply(smsReply)!;
    const pat = reply.patientSourceId;
    if (!pat || engaged.has(pat)) continue;
    const recipient = plan.recipients.find((x) => x.patientSourceId === pat);
    if (!recipient || !/^\s*(y|yes|sure|ok)\b/i.test(reply.body)) continue;
    engaged.add(pat);
    await startChild(rescheduleConversation, {
      workflowId: `slotoffer-${input.siteKey}-p${pat}-${wfId.slice(-8)}`,
      args: [{
        orgId: input.orgId,
        locationId: input.locationId,
        siteKey: input.siteKey,
        patientSourceId: pat,
        procedureSourceId: recipient.procedureSourceId
      }],
      parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON
    });
  }
  return `sent-${delivered}-engaged-${engaged.size}`;
}

// --- C2: appointment reminders + confirmation write-back ----------------------------

export interface ReminderSweepInput {
  orgId: number;
  locationId: number;
  siteKey: string;
}

// "Tomorrow at 10am — reply C to confirm." Selects tomorrow's unconfirmed,
// SMS-consented schedule; one batch approval card unless the location policy
// autoSendReminders is set (the platform's first policy-driven auto-send).
// C / YES replies flip the appointment to Confirmed INSIDE OpenDental via the
// ConfirmAppointment edge command; CHANGE replies are picked up by the
// inbound router, which starts a rescheduleConversation.
export async function reminderSweep(input: ReminderSweepInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const approval = approvalGate();
  const smsReply = smsReplyGate();

  const recipients = await acts.listReminderCandidates(input);
  if (recipients.length === 0) return "nothing-to-remind";

  const policy = await acts.getReminderPolicy({ locationId: input.locationId });
  let actionId: number | null = null;
  if (!policy.autoSend) {
    const batch = await acts.prepareReminderBatch({ ...input, workflowId: wfId, recipients });
    actionId = batch.actionId;
    const decided = await condition(() => approval.value !== null, "12 hours");
    if (!decided || approval.value!.decision === "rejected") {
      await acts.setActionStatus(actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
      return decided ? "rejected" : "expired";
    }
    await acts.setActionStatus(actionId, "approved", approval.value!.decidedBy);
  }

  let sent = 0;
  for (const r of recipients) {
    const outcome = await acts.sendOutreachSms({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: r.patientSourceId,
      body: r.message,
      workflowId: wfId,
      kind: "outreach"
    });
    if (outcome !== "blocked") sent++;
    await sleep("2 seconds"); // rate limit between texts
  }
  if (actionId !== null) await acts.setActionStatus(actionId, "executed", null);

  // Park for confirmations until the evening cap. Each C/YES write-backs
  // Confirmed to the PMS; the schedule badge updates on the next sync tick.
  const confirmed = new Set<number>();
  const deadline = Date.now() + 6 * 3_600_000;
  while (Date.now() < deadline && confirmed.size < recipients.length) {
    smsReply.value = null;
    const got = await condition(() => readReply(smsReply) !== null, deadline - Date.now());
    if (!got) break;
    const reply = readReply(smsReply)!;
    const pat = reply.patientSourceId;
    if (!pat || confirmed.has(pat)) continue;
    const r = recipients.find((x) => x.patientSourceId === pat);
    if (!r || !/^\s*(c|confirm|y|yes)\b/i.test(reply.body)) continue;
    const res = await acts.confirmAppointment({
      orgId: input.orgId,
      locationId: input.locationId,
      appointmentSourceId: r.appointmentSourceId,
      patientSourceId: pat,
      workflowId: wfId
    });
    if (res === "applied") confirmed.add(pat);
  }
  return `sent-${sent}-confirmed-${confirmed.size}`;
}

// --- C1: morning huddle digest -------------------------------------------------------

export interface MorningHuddleInput {
  orgId: number;
  locationId: number;
  siteKey: string;
}

// Office manager at 7am: one panel that says what's broken today and what to
// do about it. Refreshes no-show risk first (C4 feeds the risk list), then a
// single idempotent activity gathers the facts, drafts the narrative
// (agent or template), and upserts huddle_digests. Zero writes to the PMS.
export async function morningHuddle(input: MorningHuddleInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  await acts.scoreNoShowRisk({ orgId: input.orgId, locationId: input.locationId, daysAhead: 3 });
  const digest = await acts.generateHuddleDigest({ ...input, workflowId: wfId });
  return `digest-${digest.date}-actions-${digest.actionCount}`;
}

// --- D1: nightly metrics rollup --------------------------------------------------------

export interface MetricsRollupInput {
  orgId: number;
  locationId: number;
  siteKey: string;
  /** Days ending yesterday to (re)compute; 1 = nightly, up to 90 = backfill. */
  days?: number;
}

// Explicit rollup rows, not a matview: the nightly cron computes yesterday
// (idempotent upsert), and the same workflow re-run with days=N backfills —
// overwriting the bootstrap's synthetic seed rows with canonical numbers.
// Read-only with respect to the PMS; D2's /analytics reads only these rows.
export async function metricsRollup(input: MetricsRollupInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const res = await acts.rollupDailyMetrics({
    orgId: input.orgId,
    locationId: input.locationId,
    days: input.days ?? 1,
    workflowId: wfId
  });
  return `rolled-${res.days}-days-${res.from}..${res.to}`;
}

// --- F2: nightly audit-chain verification ------------------------------------------

export interface AuditChainVerifyInput {
  orgId: number;
}

// The chain is global (one linked list across the platform), so this runs
// once nightly, not per location. The activity recomputes every hash and
// audit-logs the outcome with the chain anchor — a broken chain also raises
// an urgent task so it lands in front of a human, not just in a log.
export async function auditChainVerify(input: AuditChainVerifyInput): Promise<string> {
  const wfId = workflowInfo().workflowId;
  const res = await acts.verifyAuditChain({ orgId: input.orgId, workflowId: wfId });
  return res.ok ? `verified-${res.checked}` : `BROKEN-at-${res.brokenAtId}`;
}
