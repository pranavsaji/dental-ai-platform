// Shared activity type surface between the workflow sandbox and the worker.
// Kept free of runtime imports so workflows.ts can import it as type-only.

export interface ProposeBackfillInput {
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
  workflowId: string;
}

export interface BackfillCandidate {
  patientSourceId: number;
  patientName: string;
  message: string;
}

// C3 cascade: the proposal carries the agent's full ranked list (best first,
// with the agent-drafted message; the rest get templates). One approval covers
// the batch — the workflow walks the list until someone says yes.
export interface BackfillProposal {
  actionId: number;
  candidates: BackfillCandidate[];
}

// --- Phase B: billing suite ----------------------------------------------------

export interface EligibilitySweepItem {
  patientSourceId: number;
  planSourceId: number;
  appointmentSourceId: number | null;
  patientName: string;
  carrierName: string;
  annualMax: number;
  deductible: number;
}

export interface PreauthCandidate {
  patientSourceId: number;
  patientName: string;
  planSourceId: number;
  carrierName: string;
  procCode: string;
  description: string;
  toothNum: string;
  fee: number;
}

export interface DenialRecord {
  denialId: number;
  patientSourceId: number;
  carcCodes: string;
  category: string;
  appealable: boolean;
  summary: string;
}

// --- Phase C: ops suite ----------------------------------------------------------

export interface OutreachRecipient {
  patientSourceId: number;
  patientName: string;
  procedureSourceId: number;
  procCode: string;
  description: string;
  fee: number;
  ageDays: number;
  message: string;
}

export interface ReminderRecipient {
  patientSourceId: number;
  patientName: string;
  appointmentSourceId: number;
  startsAt: string;
  message: string;
}

export interface SlotOffer {
  startsAt: string;
  minutes: number;
  operatorySourceId: number;
  providerSourceId: number;
  label: string;
}

export interface ReschedulePlan {
  patientSourceId: number;
  patientName: string;
  /** Set when moving an existing appointment; null when scheduling planned treatment. */
  appointmentSourceId: number | null;
  procDescript: string;
  slots: SlotOffer[];
}

export interface ActivitiesInterface {
  proposeBackfill(input: ProposeBackfillInput): Promise<BackfillProposal | null>;
  setActionStatus(actionId: number, status: string, decidedBy: string | null): Promise<void>;
  // E1: returns the policy verdict so workflows can skip blocked recipients
  // instead of waiting on replies that can never come. kind defaults to
  // outreach (quiet hours + caps); conversation/confirmation are consent-only.
  sendOutreachSms(input: {
    orgId: number; locationId: number; patientSourceId: number; body: string; workflowId: string;
    kind?: "outreach" | "conversation" | "confirmation";
  }): Promise<"sent" | "queued" | "blocked">;
  // E3: channel-aware recall delivery — email template for patients who
  // prefer email, SMS otherwise; both behind the same policy gate.
  sendRecallMessage(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    recipient: { patientSourceId: number; message: string; patientFirst?: string; patientName?: string; dateDue?: string };
  }): Promise<"sent" | "queued" | "blocked">;
  issueBookingCommand(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    providerSourceId: number; operatorySourceId: number; startsAt: string;
    minutes: number; procDescript: string;
  }): Promise<string>;
  getCommandStatus(commandId: string): Promise<string>;
  finalizeBackfill(input: {
    orgId: number; locationId: number; actionId: number; patientSourceId: number;
    workflowId: string; startsAt: string;
  }): Promise<void>;
  draftClaimFollowUp(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    // B5: when set, follow up exactly this claim (per-row button) instead of
    // letting the agent pick from the aging queue.
    targetClaimSourceId?: number | null;
  }): Promise<{ actionId: number; claimSourceId: number; patientSourceId: number; letter: string } | null>;
  recordClaimFollowUpSent(input: {
    orgId: number; locationId: number; patientSourceId: number; letter: string; workflowId: string;
  }): Promise<void>;
  checkClearinghouse(input: {
    locationId: number; claimSourceId: number; attempt: number;
  }): Promise<"paid" | "denied" | "pending">;
  escalateClaim(input: {
    orgId: number; locationId: number; siteKey: string; claimSourceId: number;
    reason: string; workflowId: string;
  }): Promise<void>;
  prepareRecallCampaign(input: {
    orgId: number; locationId: number; siteKey: string; batchSize: number; workflowId: string;
  }): Promise<{
    actionId: number;
    recipients: Array<{ patientSourceId: number; message: string; patientFirst?: string; patientName?: string; dateDue?: string }>;
  } | null>;
  // Task substrate (A5): the durable, assignable escalation path every
  // workflow can use instead of (or in addition to) a proposed-action card.
  createTask(input: {
    orgId: number; locationId: number; type: string; title: string; body?: string;
    priority?: "low" | "normal" | "high" | "urgent"; assigneeRole?: string | null;
    createdBy: string; workflowId?: string | null;
    resourceType?: string | null; resourceId?: string | null;
  }): Promise<number>;

  // --- B2: insurance eligibility verification ---------------------------------
  listEligibilitySweep(input: {
    orgId: number; locationId: number; daysAhead: number;
    appointmentSourceId?: number | null;
  }): Promise<EligibilitySweepItem[]>;
  verifyEligibility(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    item: EligibilitySweepItem; attempt: number;
  }): Promise<"verified" | "attention" | "inactive" | "unavailable">;
  recordEligibilityFailure(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    item: EligibilitySweepItem; attempts: number;
  }): Promise<void>;

  // --- B3: pre-authorization ---------------------------------------------------
  getPreauthCandidate(input: {
    orgId: number; locationId: number; procedureSourceId: number;
  }): Promise<PreauthCandidate | null>;
  draftPreauth(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    procedureSourceId: number; candidate: PreauthCandidate;
  }): Promise<{ preauthId: number; actionId: number; narrative: string }>;
  updatePreauthStatus(input: {
    orgId: number; locationId: number; preauthId: number; status: string;
    missingItem?: string; resolved?: boolean;
  }): Promise<void>;
  submitPreauthToPayer(input: {
    orgId: number; locationId: number; preauthId: number; procedureSourceId: number;
    procCode: string; fee: number; narrative: string;
  }): Promise<string>;
  checkPreauthWithPayer(input: {
    locationId: number; procedureSourceId: number; attempt: number; afterMoreInfo: boolean;
  }): Promise<{ status: "pending" | "approved" | "more_info" | "denied"; missingItem: string; payerNote: string }>;
  finalizePreauth(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    preauthId: number; procedureSourceId: number; patientSourceId: number;
    procCode: string; outcome: "approved" | "denied"; payerNote: string;
  }): Promise<void>;

  // --- B4: denial classification + appeal --------------------------------------
  recordDenial(input: {
    orgId: number; locationId: number; siteKey: string; claimSourceId: number; workflowId: string;
  }): Promise<DenialRecord>;
  draftAppeal(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    claimSourceId: number; denialId: number;
  }): Promise<{ actionId: number; letter: string }>;
  markAppealSent(input: {
    orgId: number; locationId: number; denialId: number; claimSourceId: number;
    patientSourceId: number; letter: string; workflowId: string;
  }): Promise<void>;
  checkAppeal(input: {
    locationId: number; claimSourceId: number; attempt: number;
  }): Promise<"pending" | "won" | "lost">;
  resolveAppeal(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    denialId: number; claimSourceId: number; outcome: "won" | "lost" | "stalled";
  }): Promise<void>;

  // --- C4: no-show risk ----------------------------------------------------------
  /** Score upcoming scheduled appointments; returns how many rows were stamped. */
  scoreNoShowRisk(input: {
    orgId: number; locationId: number; daysAhead: number;
  }): Promise<number>;

  // --- C5: unscheduled-treatment outreach ------------------------------------------
  prepareTreatmentOutreach(input: {
    orgId: number; locationId: number; siteKey: string; batchSize: number; workflowId: string;
  }): Promise<{ actionId: number; recipients: OutreachRecipient[] } | null>;

  // --- C2: reminders + confirmation write-back --------------------------------------
  listReminderCandidates(input: {
    orgId: number; locationId: number; siteKey: string;
  }): Promise<ReminderRecipient[]>;
  getReminderPolicy(input: { locationId: number }): Promise<{ autoSend: boolean }>;
  prepareReminderBatch(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
    recipients: ReminderRecipient[];
  }): Promise<{ actionId: number }>;
  /** Issues the ConfirmAppointment edge command and waits for the PMS ack. */
  confirmAppointment(input: {
    orgId: number; locationId: number; appointmentSourceId: number;
    patientSourceId: number; workflowId: string;
  }): Promise<"applied" | "failed">;

  // --- C3: reschedule / slot-offer conversation -------------------------------------
  findSlotCandidates(input: {
    orgId: number; locationId: number; patientSourceId: number;
    appointmentSourceId?: number | null; procedureSourceId?: number | null;
  }): Promise<ReschedulePlan | null>;
  /** Breaks the old appointment (if any) and books the chosen slot. */
  issueRescheduleCommands(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    appointmentSourceId: number | null; slot: SlotOffer; procDescript: string;
  }): Promise<{ bookingCommandId: string }>;
  finalizeReschedule(input: {
    orgId: number; locationId: number; workflowId: string; patientSourceId: number;
    appointmentSourceId: number | null; slot: SlotOffer; outcome: "booked" | "failed";
  }): Promise<void>;

  // --- C1: morning huddle ------------------------------------------------------------
  /** Gathers the day's facts, drafts the narrative, and upserts huddle_digests. */
  generateHuddleDigest(input: {
    orgId: number; locationId: number; siteKey: string; workflowId: string;
  }): Promise<{ date: string; actionCount: number; usedLlm: boolean }>;

  // --- D1: metrics rollup --------------------------------------------------------------
  /** Computes and upserts the N daily_location_metrics rows ending yesterday. */
  rollupDailyMetrics(input: {
    orgId: number; locationId: number; days: number; workflowId: string;
  }): Promise<{ days: number; from: string; to: string }>;

  // --- F2: audit-chain verification ------------------------------------------------------
  /** Recomputes the audit hash chain; broken ⇒ urgent task + audit entry. */
  verifyAuditChain(input: {
    orgId: number; workflowId: string;
  }): Promise<{ ok: boolean; checked: number; brokenAtId: number | null }>;
}
