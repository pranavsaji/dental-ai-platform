// Temporal workflow definitions. This file is bundled into Temporal's
// deterministic sandbox: only @temporalio/workflow imports allowed — no Nest,
// no DB, no network. All side effects happen in activities.

import {
  condition, defineSignal, proxyActivities, setHandler, sleep, workflowInfo
} from "@temporalio/workflow";
import type { ActivitiesInterface } from "./activities-types";

const acts = proxyActivities<ActivitiesInterface>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 5, initialInterval: "2s", backoffCoefficient: 2 }
});

export type Approval = { decision: "approved" | "rejected"; decidedBy: string };
export const approvalSignal = defineSignal<[Approval]>("approval");
export const smsReplySignal = defineSignal<[{ body: string }]>("smsReply");
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
//   detect -> agent proposes candidate + outreach -> human approves (signal)
//   -> SMS outreach -> patient replies (signal, or timer expires)
//   -> booking command -> write-back confirmed against OpenDental.
export async function cancellationBackfill(input: BackfillInput): Promise<string> {
  const wfId = workflowInfo().workflowId;

  const approval = approvalGate();
  const smsReply: { value: { body: string } | null } = { value: null };
  setHandler(smsReplySignal, (r) => { smsReply.value = r; });

  // 1. Ask the scheduling agent for a plan; parks a card in the approval queue.
  const proposal = await acts.proposeBackfill({ ...input, workflowId: wfId });
  if (!proposal) return "no-candidates";

  // 2. Human in the loop: wait up to 24h for a decision.
  const decided = await condition(() => approval.value !== null, "24 hours");
  if (!decided || approval.value!.decision === "rejected") {
    await acts.setActionStatus(proposal.actionId, decided ? "rejected" : "expired", approval.value?.decidedBy ?? null);
    return decided ? "rejected" : "expired";
  }
  await acts.setActionStatus(proposal.actionId, "approved", approval.value!.decidedBy);

  // 3. Outreach via (simulated) SMS, then race patient reply vs timeout.
  await acts.sendOutreachSms({
    orgId: input.orgId,
    locationId: input.locationId,
    patientSourceId: proposal.patientSourceId,
    body: proposal.message,
    workflowId: wfId
  });
  const replied = await condition(() => smsReply.value !== null, "4 hours");
  if (!replied) {
    await acts.setActionStatus(proposal.actionId, "expired", null);
    return "no-reply";
  }
  const positive = /^\s*(y|yes|sure|ok|confirm)/i.test(smsReply.value!.body);
  if (!positive) {
    await acts.setActionStatus(proposal.actionId, "rejected", "patient-declined");
    await acts.sendOutreachSms({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: proposal.patientSourceId,
      body: "No problem — we'll keep you on the list and reach out next time. Reply STOP to opt out.",
      workflowId: wfId
    });
    return "patient-declined";
  }

  // 4. Book it: durable command to the edge, confirmed by ack from OpenDental.
  const commandId = await acts.issueBookingCommand({
    orgId: input.orgId,
    locationId: input.locationId,
    workflowId: wfId,
    patientSourceId: proposal.patientSourceId,
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
    patientSourceId: proposal.patientSourceId,
    workflowId: wfId,
    startsAt: input.startsAt
  });
  return "booked";
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

  let sent = 0;
  for (const r of plan.recipients) {
    await acts.sendOutreachSms({
      orgId: input.orgId,
      locationId: input.locationId,
      patientSourceId: r.patientSourceId,
      body: r.message,
      workflowId: wfId
    });
    sent++;
    await sleep("2 seconds"); // rate limit between texts
  }
  await acts.setActionStatus(plan.actionId, "executed", null);
  return `sent-${sent}`;
}
