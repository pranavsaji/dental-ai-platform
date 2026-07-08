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
