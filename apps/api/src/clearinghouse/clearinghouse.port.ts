// Clearinghouse port (B1): the payer-side boundary every billing feature
// talks through. Shapes loosely mirror the X12 transactions they stand in for
// (270/271 eligibility, 276/277 claim status, 278 pre-auth, 835 remittance).
// Same seam pattern as SMS: real clearinghouse creds configured → a real
// adapter slots in here; else → MockClearinghouse (deterministic, data-driven).

export const CLEARINGHOUSE = Symbol("CLEARINGHOUSE");

export interface EligibilityRequest {
  locationId: number;
  patientSourceId: number;
  planSourceId: number;
  carrierName: string;
  annualMax: number;
  deductible: number;
  /** Retry attempt (1-based). Transient payer outages vary by attempt. */
  attempt: number;
}

export interface EligibilityResponse {
  status: "active" | "inactive" | "unavailable";
  deductibleRemaining: number;
  annualMax: number;
  annualMaxUsed: number;
  /** Frequency limitations currently hit, e.g. "prophy allowance exhausted". */
  frequencyFlags: string[];
  payerNote: string;
}

export interface ClaimStatusRequest {
  locationId: number;
  claimSourceId: number;
  /** Comma-joined CARC codes already on the claim ("" if none) — a sim-denied
   *  claim adjudicates to exactly those codes, keeping payer + PMS consistent. */
  carcCodes: string;
  daysOutstanding: number;
  /** Poll attempt (1-based) — drives the received → adjudicating → resolved
   *  state machine deterministically. */
  attempt: number;
}

export interface ClaimStatusResponse {
  status: "received" | "adjudicating" | "paid" | "denied";
  payerNote: string;
}

export interface PreAuthRequest {
  locationId: number;
  procedureSourceId: number;
  procCode: string;
  fee: number;
  narrative: string;
}

export interface PreAuthAck {
  payerReference: string;
}

export interface PreAuthStatusRequest {
  locationId: number;
  procedureSourceId: number;
  attempt: number;
  /** True once the practice has answered a more_info request — the payer then
   *  completes review instead of asking again. */
  afterMoreInfo: boolean;
}

export interface PreAuthStatusResponse {
  status: "pending" | "approved" | "more_info" | "denied";
  /** Named missing item when status = more_info. */
  missingItem: string;
  payerNote: string;
}

export interface RemittanceResponse {
  paid: boolean;
  paidAmount: number;
  carcCodes: string[];
  payerNote: string;
}

export interface AppealStatusRequest {
  locationId: number;
  claimSourceId: number;
  attempt: number;
}

export interface AppealStatusResponse {
  status: "pending" | "won" | "lost";
  payerNote: string;
}

export interface ClearinghousePort {
  checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse>;
  checkClaimStatus(req: ClaimStatusRequest): Promise<ClaimStatusResponse>;
  submitPreAuth(req: PreAuthRequest): Promise<PreAuthAck>;
  checkPreAuthStatus(req: PreAuthStatusRequest): Promise<PreAuthStatusResponse>;
  fetchRemittance(req: {
    locationId: number; claimSourceId: number; carcCodes: string; claimFee: number; insPayEst: number;
  }): Promise<RemittanceResponse>;
  checkAppealStatus(req: AppealStatusRequest): Promise<AppealStatusResponse>;
}
