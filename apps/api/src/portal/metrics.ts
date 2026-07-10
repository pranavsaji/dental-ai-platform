// D1: pure daily-metric computation. MetricsService gathers raw facts from
// canonical SQL and this module turns them into a daily_location_metrics row —
// keeping every rate, ratio, and AR bucket rule in one unit-tested place
// (same pattern as slots.ts and @dental/shared's noshow.ts).

export interface OpenClaimAge {
  /** Days outstanding relative to the metric date (dateSent, dateService fallback). */
  ageDays: number;
  /** Outstanding value: claimFee − insPayAmt. */
  value: number;
}

export interface DailyMetricFacts {
  date: string; // YYYY-MM-DD
  /** Appointments on the day with status scheduled | complete | broken. */
  appointmentsCount: number;
  /** Broken appointments on the day that are NOT no-shows. */
  cancellationCount: number;
  /** Broken appointments on the day whose note marks a no-show (A3 convention). */
  noshowCount: number;
  /** Minutes booked that day (scheduled + complete appointments). */
  bookedMinutes: number;
  /** Visible operatories — capacity is operatories × 8h. */
  operatoryCount: number;
  /** Fees of procedures attached to the day's appointments (what was on the books). */
  productionScheduled: number;
  /** Fees of procedures completed that day. */
  productionCompleted: number;
  /** Payments posted that day (insurance + patient). */
  collections: number;
  /** Distinct patients with a completed hygiene procedure (D1110/D1120/D4910) that day. */
  hygienePatientsSeen: number;
  /** Of those, patients holding a future scheduled appointment. */
  hygienePatientsReappointed: number;
  /** Planned-treatment value with no future appointment (point-in-time snapshot). */
  unscheduledTreatmentValue: number;
  /** Open (sent | waiting) claims outstanding as of the day, with ages. */
  openClaimAges: OpenClaimAge[];
  /** Denials recorded (claim_denials rows created) that day. */
  denialCount: number;
  /** Patients whose first visit was that day. */
  newPatients: number;
  /** Procedures presented that day (treatment-planned or completed). */
  casesPresented: number;
  /** Of those, completed or planned-with-a-future-booking. */
  casesAccepted: number;
}

export interface DailyMetricValues {
  date: string;
  productionScheduled: number;
  productionCompleted: number;
  collections: number;
  cancellationCount: number;
  noshowCount: number;
  brokenRate: number;
  hygieneReappointmentRate: number;
  unscheduledTreatmentValue: number;
  ar0_30: number;
  ar31_60: number;
  ar61_90: number;
  ar90Plus: number;
  openClaimsValue: number;
  denialCount: number;
  newPatients: number;
  caseAcceptanceRate: number;
  appointmentsCount: number;
  chairUtilization: number;
}

export type ArBucket = "0-30" | "31-60" | "61-90" | "90+";

/** Same boundaries as the B5 billing worklist — the tiles must reconcile. */
export function arBucketOf(ageDays: number): ArBucket {
  if (ageDays <= 30) return "0-30";
  if (ageDays <= 60) return "31-60";
  if (ageDays <= 90) return "61-90";
  return "90+";
}

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 10_000) / 10_000 : 0);

export function computeDailyMetrics(f: DailyMetricFacts): DailyMetricValues {
  const buckets: Record<ArBucket, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
  let openClaimsValue = 0;
  for (const c of f.openClaimAges) {
    const v = Math.max(0, c.value);
    buckets[arBucketOf(Math.max(0, c.ageDays))] += v;
    openClaimsValue += v;
  }

  const capacityMinutes = f.operatoryCount * 8 * 60;

  return {
    date: f.date,
    productionScheduled: Math.round(f.productionScheduled),
    productionCompleted: Math.round(f.productionCompleted),
    collections: Math.round(f.collections),
    cancellationCount: f.cancellationCount,
    noshowCount: f.noshowCount,
    brokenRate: rate(f.cancellationCount + f.noshowCount, f.appointmentsCount),
    hygieneReappointmentRate: rate(f.hygienePatientsReappointed, f.hygienePatientsSeen),
    unscheduledTreatmentValue: Math.round(f.unscheduledTreatmentValue),
    ar0_30: Math.round(buckets["0-30"]),
    ar31_60: Math.round(buckets["31-60"]),
    ar61_90: Math.round(buckets["61-90"]),
    ar90Plus: Math.round(buckets["90+"]),
    openClaimsValue: Math.round(openClaimsValue),
    denialCount: f.denialCount,
    newPatients: f.newPatients,
    caseAcceptanceRate: rate(f.casesAccepted, f.casesPresented),
    appointmentsCount: f.appointmentsCount,
    chairUtilization: rate(f.bookedMinutes, capacityMinutes)
  };
}
