import { describe, expect, it } from "vitest";
import { CARC_CODES, CARRIER_RULES, classifyDenial, requiresPreauth } from "@dental/shared";
import { MockClearinghouse, fnv1a } from "./mock.clearinghouse";

// Contract tests (B1): the mock clearinghouse must be deterministic —
// identical requests always produce identical responses — and its answers
// must stay consistent with the shared CARRIER_RULES / CARC_CODES facts.

const ch = new MockClearinghouse();

describe("fnv1a", () => {
  it("is stable and well-spread", () => {
    expect(fnv1a("elig:1:2:3")).toBe(fnv1a("elig:1:2:3"));
    expect(fnv1a("a")).not.toBe(fnv1a("b"));
  });
});

describe("checkEligibility", () => {
  const base = {
    locationId: 1, patientSourceId: 7, planSourceId: 3,
    carrierName: "Delta Dental of Texas", annualMax: 1500, deductible: 50, attempt: 1
  };

  it("is deterministic for identical requests", async () => {
    const a = await ch.checkEligibility(base);
    const b = await ch.checkEligibility({ ...base });
    expect(a).toEqual(b);
  });

  it("covers active / inactive / unavailable across the id space", async () => {
    const statuses = new Set<string>();
    for (let pat = 1; pat <= 300; pat++) {
      const r = await ch.checkEligibility({ ...base, patientSourceId: pat, planSourceId: pat % 20 });
      statuses.add(r.status);
      if (r.status === "active") {
        expect(r.annualMaxUsed).toBeGreaterThanOrEqual(0);
        expect(r.annualMaxUsed).toBeLessThanOrEqual(r.annualMax);
      }
    }
    expect(statuses).toEqual(new Set(["active", "inactive", "unavailable"]));
  });

  it("fills benefit facts from CARRIER_RULES when the plan row has none", async () => {
    const delta = CARRIER_RULES.find((c) => c.carrierName === "Delta Dental of Texas")!;
    for (let pat = 1; pat <= 50; pat++) {
      const r = await ch.checkEligibility({ ...base, patientSourceId: pat, annualMax: 0, deductible: 0 });
      if (r.status === "active") {
        expect(r.annualMax).toBe(delta.annualMax);
        return;
      }
    }
    throw new Error("no active response in 50 patients");
  });

  it("an outage can clear on retry (attempt is part of the outcome key)", async () => {
    // Find a request that is unavailable on some attempt, then show another
    // attempt succeeds — the durable-retry path is actually exercisable.
    for (let pat = 1; pat <= 500; pat++) {
      const first = await ch.checkEligibility({ ...base, patientSourceId: pat });
      if (first.status !== "unavailable") continue;
      const retries = await Promise.all([2, 3, 4].map((attempt) =>
        ch.checkEligibility({ ...base, patientSourceId: pat, attempt })));
      expect(retries.some((r) => r.status !== "unavailable")).toBe(true);
      return;
    }
    throw new Error("no unavailable outcome found in 500 patients");
  });
});

describe("checkClaimStatus + fetchRemittance", () => {
  it("a sim-denied claim adjudicates to exactly its seeded CARCs", async () => {
    const status = await ch.checkClaimStatus({
      locationId: 1, claimSourceId: 42, carcCodes: "16,97", daysOutstanding: 30, attempt: 2
    });
    expect(status.status).toBe("denied");
    const era = await ch.fetchRemittance({
      locationId: 1, claimSourceId: 42, carcCodes: "16,97", claimFee: 900, insPayEst: 540
    });
    expect(era.paid).toBe(false);
    expect(era.carcCodes).toEqual(["16", "97"]);
    expect(era.payerNote).toContain(CARC_CODES["16"].description);
  });

  it("progresses received → adjudicating → resolved and stays deterministic", async () => {
    const req = { locationId: 1, claimSourceId: 9001, carcCodes: "", daysOutstanding: 20 };
    const first = await ch.checkClaimStatus({ ...req, attempt: 1 });
    expect(first.status).toBe("received");
    let resolved: string | null = null;
    for (let attempt = 2; attempt <= 8; attempt++) {
      const r = await ch.checkClaimStatus({ ...req, attempt });
      if (r.status === "paid" || r.status === "denied") { resolved = r.status; break; }
      expect(r.status).toBe("adjudicating");
    }
    expect(resolved).not.toBeNull();
    // Replay: same attempt sequence gives the same terminal outcome.
    const replay = await ch.checkClaimStatus({ ...req, attempt: 8 });
    expect(replay.status).toBe(resolved);
  });

  it("remittance agrees with adjudication for payer-denied claims", async () => {
    let sawDenial = false;
    for (let id = 1; id <= 200; id++) {
      const status = await ch.checkClaimStatus({
        locationId: 1, claimSourceId: id, carcCodes: "", daysOutstanding: 90, attempt: 10
      });
      const era = await ch.fetchRemittance({
        locationId: 1, claimSourceId: id, carcCodes: "", claimFee: 500, insPayEst: 300
      });
      expect(era.paid).toBe(status.status === "paid");
      if (!era.paid) {
        sawDenial = true;
        expect(era.carcCodes.length).toBeGreaterThan(0);
        // Every payer-picked CARC is in the shared vocabulary (B4 can classify it).
        for (const c of era.carcCodes) expect(CARC_CODES[c]).toBeDefined();
      }
    }
    expect(sawDenial).toBe(true);
  });
});

describe("pre-auth lifecycle", () => {
  it("acks with a stable payer reference", async () => {
    const a = await ch.submitPreAuth({ locationId: 1, procedureSourceId: 77, procCode: "D2740", fee: 1250, narrative: "x" });
    const b = await ch.submitPreAuth({ locationId: 1, procedureSourceId: 77, procCode: "D2740", fee: 1250, narrative: "x" });
    expect(a.payerReference).toBe(b.payerReference);
    expect(a.payerReference).toMatch(/^PA-/);
  });

  it("resolves approved / more_info / denied across the id space; more_info names the item", async () => {
    const outcomes = new Set<string>();
    for (let proc = 1; proc <= 200; proc++) {
      const r = await ch.checkPreAuthStatus({ locationId: 1, procedureSourceId: proc, attempt: 10, afterMoreInfo: false });
      outcomes.add(r.status);
      if (r.status === "more_info") expect(r.missingItem).not.toBe("");
    }
    expect(outcomes).toEqual(new Set(["approved", "more_info", "denied"]));
  });

  it("approves after the practice supplies the requested item", async () => {
    for (let proc = 1; proc <= 200; proc++) {
      const r = await ch.checkPreAuthStatus({ locationId: 1, procedureSourceId: proc, attempt: 10, afterMoreInfo: false });
      if (r.status !== "more_info") continue;
      const after = await ch.checkPreAuthStatus({ locationId: 1, procedureSourceId: proc, attempt: 11, afterMoreInfo: true });
      expect(after.status).toBe("approved");
      return;
    }
    throw new Error("no more_info outcome found");
  });
});

describe("appeal outcomes", () => {
  it("pends then resolves won or lost, deterministically", async () => {
    const outcomes = new Set<string>();
    for (let claim = 1; claim <= 100; claim++) {
      const early = await ch.checkAppealStatus({ locationId: 1, claimSourceId: claim, attempt: 1 });
      expect(early.status).toBe("pending");
      const final = await ch.checkAppealStatus({ locationId: 1, claimSourceId: claim, attempt: 10 });
      expect(["won", "lost"]).toContain(final.status);
      const replay = await ch.checkAppealStatus({ locationId: 1, claimSourceId: claim, attempt: 10 });
      expect(replay.status).toBe(final.status);
      outcomes.add(final.status);
    }
    expect(outcomes).toEqual(new Set(["won", "lost"]));
  });
});

describe("shared insurance helpers", () => {
  it("classifyDenial maps CARCs to a category with appealable flag", () => {
    expect(classifyDenial(["16", "97"])).toEqual({
      category: "missing_documentation",
      appealable: true,
      descriptions: [
        `CARC 16: ${CARC_CODES["16"].description}`,
        `CARC 97: ${CARC_CODES["97"].description}`
      ]
    });
    expect(classifyDenial(["45"]).appealable).toBe(false);
    expect(classifyDenial(["45"]).category).toBe("administrative");
    expect(classifyDenial(["unknown"]).category).toBe("administrative");
  });

  it("requiresPreauth flags crowns/SRP/implants, not diagnostics", () => {
    expect(requiresPreauth("D2740")).toBe(true);  // crown
    expect(requiresPreauth("D4341")).toBe(true);  // SRP
    expect(requiresPreauth("D6010")).toBe(true);  // implant
    expect(requiresPreauth("D0120")).toBe(false); // exam
    expect(requiresPreauth("D1110")).toBe(false); // prophy
  });
});
