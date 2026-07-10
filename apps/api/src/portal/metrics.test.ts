import { describe, expect, it } from "vitest";
import { arBucketOf, computeDailyMetrics, type DailyMetricFacts } from "./metrics";

// D1 unit tests: the rollup's rates, ratios, and AR bucketing are the
// deterministic core the analytics UI and insights agent read — exact rules.

const base: DailyMetricFacts = {
  date: "2026-07-09",
  appointmentsCount: 20,
  cancellationCount: 0,
  noshowCount: 0,
  bookedMinutes: 0,
  operatoryCount: 6,
  productionScheduled: 0,
  productionCompleted: 0,
  collections: 0,
  hygienePatientsSeen: 0,
  hygienePatientsReappointed: 0,
  unscheduledTreatmentValue: 0,
  openClaimAges: [],
  denialCount: 0,
  newPatients: 0,
  casesPresented: 0,
  casesAccepted: 0
};

describe("arBucketOf (D1)", () => {
  it("uses the same boundaries as the B5 worklist", () => {
    expect(arBucketOf(0)).toBe("0-30");
    expect(arBucketOf(30)).toBe("0-30");
    expect(arBucketOf(31)).toBe("31-60");
    expect(arBucketOf(60)).toBe("31-60");
    expect(arBucketOf(61)).toBe("61-90");
    expect(arBucketOf(90)).toBe("61-90");
    expect(arBucketOf(91)).toBe("90+");
  });
});

describe("computeDailyMetrics (D1)", () => {
  it("buckets AR by age and totals the outstanding value", () => {
    const m = computeDailyMetrics({
      ...base,
      openClaimAges: [
        { ageDays: 5, value: 100 },
        { ageDays: 30, value: 50 },
        { ageDays: 31, value: 200 },
        { ageDays: 90, value: 75 },
        { ageDays: 120, value: 300 }
      ]
    });
    expect(m.ar0_30).toBe(150);
    expect(m.ar31_60).toBe(200);
    expect(m.ar61_90).toBe(75);
    expect(m.ar90Plus).toBe(300);
    expect(m.openClaimsValue).toBe(725);
    expect(m.ar0_30 + m.ar31_60 + m.ar61_90 + m.ar90Plus).toBe(m.openClaimsValue);
  });

  it("never lets an overpaid claim subtract from AR", () => {
    const m = computeDailyMetrics({
      ...base,
      openClaimAges: [{ ageDays: 10, value: -40 }, { ageDays: 10, value: 100 }]
    });
    expect(m.ar0_30).toBe(100);
    expect(m.openClaimsValue).toBe(100);
  });

  it("computes broken rate over the day's appointment count", () => {
    const m = computeDailyMetrics({ ...base, cancellationCount: 2, noshowCount: 1 });
    expect(m.brokenRate).toBeCloseTo(0.15, 4); // 3 / 20
    expect(m.cancellationCount).toBe(2);
    expect(m.noshowCount).toBe(1);
  });

  it("guards every ratio against a zero denominator", () => {
    const m = computeDailyMetrics({
      ...base,
      appointmentsCount: 0,
      operatoryCount: 0,
      cancellationCount: 0
    });
    expect(m.brokenRate).toBe(0);
    expect(m.hygieneReappointmentRate).toBe(0);
    expect(m.caseAcceptanceRate).toBe(0);
    expect(m.chairUtilization).toBe(0);
  });

  it("computes chair utilization against operatories × 8h", () => {
    const m = computeDailyMetrics({ ...base, bookedMinutes: 1440, operatoryCount: 6 });
    expect(m.chairUtilization).toBe(0.5); // 1440 / 2880
  });

  it("computes hygiene reappointment and case acceptance rates", () => {
    const m = computeDailyMetrics({
      ...base,
      hygienePatientsSeen: 8,
      hygienePatientsReappointed: 6,
      casesPresented: 4,
      casesAccepted: 3
    });
    expect(m.hygieneReappointmentRate).toBe(0.75);
    expect(m.caseAcceptanceRate).toBe(0.75);
  });

  it("rounds money to whole dollars and passes counts through", () => {
    const m = computeDailyMetrics({
      ...base,
      productionScheduled: 1234.56,
      productionCompleted: 1100.4,
      collections: 987.5,
      unscheduledTreatmentValue: 28000.9,
      denialCount: 2,
      newPatients: 3
    });
    expect(m.productionScheduled).toBe(1235);
    expect(m.productionCompleted).toBe(1100);
    expect(m.collections).toBe(988);
    expect(m.unscheduledTreatmentValue).toBe(28001);
    expect(m.denialCount).toBe(2);
    expect(m.newPatients).toBe(3);
    expect(m.date).toBe("2026-07-09");
  });
});
