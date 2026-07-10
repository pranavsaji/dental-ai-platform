import { Injectable, Logger } from "@nestjs/common";

// HTTP client for the Python LangGraph agent service. If the service is down
// or has no LLM key, we fall back to a deterministic template so the demo
// pipeline still runs end-to-end.

export interface SchedulingCandidate {
  patientSourceId: number;
  name: string;
  phone: string;
  overdueSince: string | null;
  lastVisit: string | null;
}

export interface SchedulingProposal {
  patientSourceId: number;
  message: string;
  rationale: string;
  usedLlm: boolean;
}

@Injectable()
export class AgentsClient {
  private readonly log = new Logger("AgentsClient");
  private baseUrl = process.env.AGENTS_URL ?? "http://localhost:8000";

  async proposeScheduling(input: {
    locationName: string;
    slot: { startsAt: string; minutes: number; procDescript: string };
    cancelledPatientName: string;
    candidates: SchedulingCandidate[];
  }): Promise<SchedulingProposal> {
    try {
      const res = await fetch(`${this.baseUrl}/scheduling/propose`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`agents service HTTP ${res.status}`);
      const out = (await res.json()) as SchedulingProposal;
      if (!input.candidates.some((c) => c.patientSourceId === out.patientSourceId)) {
        throw new Error("agent chose a patient outside the candidate list");
      }
      return out;
    } catch (err) {
      this.log.warn(`agent service unavailable (${(err as Error).message}); using fallback proposal`);
      const first = input.candidates[0];
      const when = new Date(input.slot.startsAt).toLocaleString([], {
        weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
      });
      return {
        patientSourceId: first.patientSourceId,
        message:
          `Hi ${first.name.split(" ")[0]}, this is ${input.locationName}. ` +
          `An appointment just opened up on ${when} and you're due for a visit. ` +
          `Would you like it? Reply YES to book or NO to pass.`,
        rationale: "Fallback: first overdue-recall candidate (agent service unreachable).",
        usedLlm: false
      };
    }
  }

  // --- Phase B billing agent surfaces. Each has a deterministic fallback so
  // the billing suite never blocks on the agents service being up or keyed.

  async summarizeEligibility(input: {
    patientName: string;
    carrierName: string;
    status: string; // verified | inactive | attention | failed
    deductibleRemaining: number;
    annualMax: number;
    annualMaxUsed: number;
    frequencyFlags: string[];
    payerNote: string;
  }): Promise<{ summary: string; usedLlm: boolean }> {
    const fallback = () => {
      const parts: string[] = [];
      if (input.status === "inactive") {
        parts.push(`${input.carrierName} reports coverage inactive for ${input.patientName}.`);
      } else if (input.status === "failed") {
        parts.push(`Eligibility could not be verified with ${input.carrierName} (payer system unavailable after retries).`);
      } else {
        parts.push(`${input.carrierName} coverage active for ${input.patientName}.`);
        parts.push(`$${Math.max(0, input.annualMax - input.annualMaxUsed).toFixed(0)} of $${input.annualMax.toFixed(0)} annual max remaining; deductible remaining $${input.deductibleRemaining.toFixed(0)}.`);
      }
      if (input.frequencyFlags.length > 0) parts.push(`Limitations: ${input.frequencyFlags.join("; ")}.`);
      if (input.payerNote) parts.push(input.payerNote);
      return { summary: parts.join(" "), usedLlm: false };
    };
    try {
      const res = await fetch(`${this.baseUrl}/billing/eligibility-summary`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(30_000)
      });
      if (!res.ok) throw new Error(`agents service HTTP ${res.status}`);
      return (await res.json()) as any;
    } catch (err) {
      this.log.warn(`eligibility-summary agent unavailable (${(err as Error).message}); using template`);
      return fallback();
    }
  }

  async draftPreauth(input: {
    locationName: string;
    patientName: string;
    carrierName: string;
    procCode: string;
    description: string;
    toothNum: string;
    fee: number;
    notes: Array<{ id: number; note: string }>;
  }): Promise<{ narrative: string; usedLlm: boolean }> {
    const fallback = () => ({
      narrative:
        `Pre-authorization request to ${input.carrierName} for ${input.patientName}: ` +
        `${input.description} (${input.procCode}${input.toothNum ? `, tooth ${input.toothNum}` : ""}), ` +
        `planned fee $${input.fee.toFixed(2)}. Treatment is clinically indicated per the attached chart ` +
        `documentation${input.notes.length > 0 ? ` (notes ${input.notes.map((n) => n.id).join(", ")})` : ""}. ` +
        `Radiographs and clinical notes available on request. — ${input.locationName} billing office`,
      usedLlm: false
    });
    try {
      const res = await fetch(`${this.baseUrl}/billing/preauth-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`agents service HTTP ${res.status}`);
      return (await res.json()) as any;
    } catch (err) {
      this.log.warn(`preauth-draft agent unavailable (${(err as Error).message}); using template`);
      return fallback();
    }
  }

  async draftAppeal(input: {
    locationName: string;
    patientName: string;
    carrierName: string;
    claimSourceId: number;
    dateService: string | null;
    claimFee: number;
    carcCodes: string[];
    category: string;
    carcDescriptions: string[];
  }): Promise<{ summary: string; letter: string; usedLlm: boolean }> {
    const fallback = () => ({
      summary:
        `Denied by ${input.carrierName} (${input.category.replace(/_/g, " ")}): ` +
        `${input.carcDescriptions.join("; ") || `CARC ${input.carcCodes.join(", ")}`}.`,
      letter:
        `To ${input.carrierName} Appeals Department:\n\n` +
        `We formally appeal the denial of the claim for ${input.patientName}, date of service ` +
        `${input.dateService ?? "on file"}, billed $${input.claimFee.toFixed(2)}, denied under ` +
        `CARC ${input.carcCodes.join(", ")} (${input.category.replace(/_/g, " ")}). The treatment was ` +
        `clinically necessary and properly documented in the patient chart; supporting documentation ` +
        `is enclosed. We request reprocessing of this claim and payment per plan benefits. Please ` +
        `respond within 30 days.\n\n— ${input.locationName} billing office`,
      usedLlm: false
    });
    try {
      const res = await fetch(`${this.baseUrl}/billing/appeal-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`agents service HTTP ${res.status}`);
      return (await res.json()) as any;
    } catch (err) {
      this.log.warn(`appeal-draft agent unavailable (${(err as Error).message}); using template`);
      return fallback();
    }
  }

  async reviewClaims(input: {
    locationName: string;
    claims: Array<{
      claimSourceId: number; patientName: string; carrierName: string;
      dateService: string | null; dateSent: string | null;
      claimFee: number; insPayEst: number; daysOutstanding: number;
    }>;
  }): Promise<{ claimSourceId: number; rationale: string; letter: string; usedLlm: boolean }> {
    try {
      const res = await fetch(`${this.baseUrl}/billing/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(90_000)
      });
      if (!res.ok) throw new Error(`agents service HTTP ${res.status}`);
      return (await res.json()) as any;
    } catch (err) {
      this.log.warn(`billing agent unavailable (${(err as Error).message}); using fallback`);
      const worst = [...input.claims].sort(
        (a, b) => b.daysOutstanding - a.daysOutstanding || b.claimFee - a.claimFee
      )[0];
      return {
        claimSourceId: worst.claimSourceId,
        rationale: `Fallback: oldest claim (${worst.daysOutstanding} days outstanding).`,
        letter:
          `To ${worst.carrierName}: We are following up on the claim for ${worst.patientName}, ` +
          `date of service ${worst.dateService}, submitted ${worst.dateSent} ` +
          `(${worst.daysOutstanding} days ago; billed $${worst.claimFee.toFixed(2)}). ` +
          `Please provide the current adjudication status and expected payment date. ` +
          `— ${input.locationName} billing office`,
        usedLlm: false
      };
    }
  }
}
