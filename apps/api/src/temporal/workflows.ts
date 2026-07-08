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

// Ref-holders so TypeScript doesn't narrow signal state to `never` across
// awaits (signals mutate from outside the workflow's control flow).
function approvalGate(): { value: Approval | null } {
  const ref: { value: Approval | null } = { value: null };
  setHandler(approvalSignal, (a) => { ref.value = a; });
  return ref;
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
}

// Billing: agent picks the worst aging claim and drafts the carrier follow-up
// -> human approves -> follow-up recorded against the chart -> durable polling
// of the (mock) clearinghouse until adjudicated, escalating if it stalls.
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
  // resolves. Mock clearinghouse resolves probabilistically per check.
  for (let attempt = 1; attempt <= 20; attempt++) {
    const status = await acts.checkClearinghouse(draft.claimSourceId, attempt);
    if (status === "paid") {
      await acts.setActionStatus(draft.actionId, "executed", null);
      return "paid";
    }
    if (status === "denied") {
      await acts.escalateClaim({ ...input, claimSourceId: draft.claimSourceId, reason: "denied", workflowId: wfId });
      await acts.setActionStatus(draft.actionId, "executed", null);
      return "denied-escalated";
    }
    await sleep("15 seconds"); // demo cadence; production would be daily timers
  }
  await acts.escalateClaim({ ...input, claimSourceId: draft.claimSourceId, reason: "no adjudication after 20 checks", workflowId: wfId });
  await acts.setActionStatus(draft.actionId, "executed", null);
  return "stalled-escalated";
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
