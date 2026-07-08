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

export interface BackfillProposal {
  actionId: number;
  patientSourceId: number;
  patientName: string;
  message: string;
}

export interface ActivitiesInterface {
  proposeBackfill(input: ProposeBackfillInput): Promise<BackfillProposal | null>;
  setActionStatus(actionId: number, status: string, decidedBy: string | null): Promise<void>;
  sendOutreachSms(input: {
    orgId: number; locationId: number; patientSourceId: number; body: string; workflowId: string;
  }): Promise<void>;
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
  }): Promise<{ actionId: number; claimSourceId: number; patientSourceId: number; letter: string } | null>;
  recordClaimFollowUpSent(input: {
    orgId: number; locationId: number; patientSourceId: number; letter: string; workflowId: string;
  }): Promise<void>;
  checkClearinghouse(claimSourceId: number, attempt: number): Promise<"paid" | "denied" | "pending">;
  escalateClaim(input: {
    orgId: number; locationId: number; siteKey: string; claimSourceId: number;
    reason: string; workflowId: string;
  }): Promise<void>;
  prepareRecallCampaign(input: {
    orgId: number; locationId: number; siteKey: string; batchSize: number; workflowId: string;
  }): Promise<{ actionId: number; recipients: Array<{ patientSourceId: number; message: string }> } | null>;
}
