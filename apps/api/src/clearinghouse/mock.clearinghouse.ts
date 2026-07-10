import { Injectable, Logger } from "@nestjs/common";
import { CARC_CODES, carrierRules } from "@dental/shared";
import type {
  AppealStatusRequest, AppealStatusResponse, ClaimStatusRequest, ClaimStatusResponse,
  ClearinghousePort, EligibilityRequest, EligibilityResponse, PreAuthAck,
  PreAuthRequest, PreAuthStatusRequest, PreAuthStatusResponse, RemittanceResponse
} from "./clearinghouse.port";

// Deterministic mock clearinghouse (B1). Every outcome is a pure function of
// the request identity — hash(entity ids), never Math.random() — so demos and
// tests are replayable. Benefit facts come from CARRIER_RULES and denial
// vocabulary from CARC_CODES in @dental/shared: the same single source of
// truth the seeder wrote into the sim insplan rows, keeping payer answers and
// PMS data internally consistent.

/** FNV-1a 32-bit — stable, fast, good spread for id-keyed outcomes. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Deterministic CARC picks for claims the payer (not the sim) denies. Weighted
// toward the appealable/documentation codes that make good worklist demos.
const PAYER_DENIAL_CARCS = [["16"], ["96"], ["50"], ["197"], ["16", "45"], ["22"]];

const MISSING_ITEMS = [
  "periapical radiograph required",
  "clinical narrative required",
  "full-mouth series or panoramic image required",
  "periodontal charting required"
];

@Injectable()
export class MockClearinghouse implements ClearinghousePort {
  private readonly log = new Logger("MockClearinghouse");

  async checkEligibility(req: EligibilityRequest): Promise<EligibilityResponse> {
    // Transient outage: ~3% per attempt (attempt is in the key so a retry can
    // succeed — this exercises the durable-retry-then-task path).
    const outage = fnv1a(`elig-outage:${req.locationId}:${req.planSourceId}:${req.patientSourceId}:${req.attempt}`);
    if (outage % 100 < 3) {
      return {
        status: "unavailable", deductibleRemaining: 0, annualMax: 0, annualMaxUsed: 0,
        frequencyFlags: [], payerNote: "Payer system temporarily unavailable (AAA*42). Retry later."
      };
    }

    const h = fnv1a(`elig:${req.locationId}:${req.planSourceId}:${req.patientSourceId}`);
    const rules = carrierRules(req.carrierName);
    const annualMax = req.annualMax || rules?.annualMax || 1500;
    const deductible = req.deductible || rules?.deductible || 50;

    // ~5% of coverages come back inactive/termed.
    if (h % 100 < 5) {
      return {
        status: "inactive", deductibleRemaining: 0, annualMax, annualMaxUsed: 0,
        frequencyFlags: [],
        payerNote: `Coverage terminated. Contact ${req.carrierName}${rules ? ` at ${rules.carrierPhone}` : ""}.`
      };
    }

    const usedPct = (h >>> 8) % 100; // 0–99% of annual max consumed
    const annualMaxUsed = Math.round(annualMax * usedPct / 100);
    const deductibleMet = ((h >>> 16) % 100) < 60; // 60% have met their deductible
    const frequencyFlags: string[] = [];
    if ((h >>> 24) % 10 < 2) frequencyFlags.push("prophy allowance exhausted for this benefit year");
    if ((h >>> 26) % 20 === 0) frequencyFlags.push("bitewing series already paid this benefit year");

    return {
      status: "active",
      deductibleRemaining: deductibleMet ? 0 : deductible,
      annualMax,
      annualMaxUsed,
      frequencyFlags,
      payerNote: rules
        ? `Verified with ${req.carrierName} (payer ${rules.payerId}).`
        : `Verified with ${req.carrierName}.`
    };
  }

  async checkClaimStatus(req: ClaimStatusRequest): Promise<ClaimStatusResponse> {
    // Sim-denied claims (CARCs already on the claim) adjudicate to denied on
    // the payer's first real look — one "received" beat, then the denial.
    if (req.carcCodes.trim() !== "") {
      if (req.attempt <= 1) return { status: "received", payerNote: "Claim received; pending adjudication." };
      return { status: "denied", payerNote: `Adjudicated. See remittance for CARC ${req.carcCodes}.` };
    }

    const h = fnv1a(`claim:${req.locationId}:${req.claimSourceId}`);
    // Older claims resolve faster in demos (they've "been in the queue" longer).
    const resolveAfter = req.daysOutstanding > 60 ? 1 : 2 + (h % 3);
    if (req.attempt <= resolveAfter) {
      return {
        status: req.attempt === 1 ? "received" : "adjudicating",
        payerNote: req.attempt === 1 ? "Claim received; pending adjudication." : "In adjudication."
      };
    }
    // ~12% of clean claims still deny at the payer.
    if ((h >>> 8) % 100 < 12) {
      return { status: "denied", payerNote: "Adjudicated with denial. Fetch remittance for reason codes." };
    }
    return { status: "paid", payerNote: "Adjudicated and paid per plan benefits." };
  }

  async submitPreAuth(req: PreAuthRequest): Promise<PreAuthAck> {
    const h = fnv1a(`preauth:${req.locationId}:${req.procedureSourceId}`);
    const ref = `PA-${h.toString(36).toUpperCase().padStart(7, "0")}`;
    this.log.log(`pre-auth submitted for procedure ${req.procedureSourceId} (${req.procCode}) → ${ref}`);
    return { payerReference: ref };
  }

  async checkPreAuthStatus(req: PreAuthStatusRequest): Promise<PreAuthStatusResponse> {
    const h = fnv1a(`preauth:${req.locationId}:${req.procedureSourceId}`);
    // 24–72 simulated hours of payer review, compressed to 2–4 polls.
    const resolveAfter = 2 + (h % 3);
    if (req.attempt <= resolveAfter) {
      return { status: "pending", missingItem: "", payerNote: "Under clinical review." };
    }
    // After the practice supplies the requested item, the payer approves —
    // the demo path resolves rather than looping on more_info forever.
    if (req.afterMoreInfo) {
      return { status: "approved", missingItem: "", payerNote: "Approved following receipt of requested documentation." };
    }
    const roll = (h >>> 8) % 10;
    if (roll < 7) return { status: "approved", missingItem: "", payerNote: "Authorized as submitted." };
    if (roll < 9) {
      const missingItem = MISSING_ITEMS[(h >>> 16) % MISSING_ITEMS.length];
      return { status: "more_info", missingItem, payerNote: `Additional information required: ${missingItem}.` };
    }
    return { status: "denied", missingItem: "", payerNote: "Not authorized — does not meet plan criteria." };
  }

  async fetchRemittance(req: {
    locationId: number; claimSourceId: number; carcCodes: string; claimFee: number; insPayEst: number;
  }): Promise<RemittanceResponse> {
    const h = fnv1a(`claim:${req.locationId}:${req.claimSourceId}`);
    // Same hash as checkClaimStatus, so remittance agrees with adjudication.
    const simDenied = req.carcCodes.trim() !== "";
    const payerDenied = (h >>> 8) % 100 < 12;
    if (simDenied || payerDenied) {
      const carcs = simDenied
        ? req.carcCodes.split(",").map((c) => c.trim()).filter(Boolean)
        : PAYER_DENIAL_CARCS[(h >>> 16) % PAYER_DENIAL_CARCS.length];
      const reasons = carcs.map((c) => CARC_CODES[c]?.description ?? `reason code ${c}`).join("; ");
      return { paid: false, paidAmount: 0, carcCodes: carcs, payerNote: `Denied: ${reasons}.` };
    }
    return {
      paid: true,
      paidAmount: Math.round(req.insPayEst * 100) / 100,
      carcCodes: [],
      payerNote: "Paid per plan benefits."
    };
  }

  async checkAppealStatus(req: AppealStatusRequest): Promise<AppealStatusResponse> {
    const h = fnv1a(`appeal:${req.locationId}:${req.claimSourceId}`);
    const resolveAfter = 2 + (h % 2);
    if (req.attempt <= resolveAfter) {
      return { status: "pending", payerNote: "Appeal under review." };
    }
    return ((h >>> 8) % 10) < 6
      ? { status: "won", payerNote: "Appeal upheld — claim reprocessed for payment." }
      : { status: "lost", payerNote: "Appeal denied — original determination stands." };
  }
}
