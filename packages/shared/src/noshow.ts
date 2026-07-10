// No-show risk scoring (C4). Deterministic, explainable, no ML: a weighted
// feature score with a factor trail rich enough that a future model swap-in
// changes nothing downstream. Consumed by the nightly sweep (which stamps
// appointments.no_show_risk), the schedule badge, the huddle risk list, and
// the scheduling agent's candidate ranking.

export interface NoShowFeatures {
  /** Past appointments for this patient (any terminal status). */
  pastAppointments: number;
  /** Of those, no-shows (broken with a no-show note). */
  pastNoShows: number;
  /** Broken-but-not-no-show history (late cancels). */
  priorLateCancels: number;
  /** Has the upcoming appointment been confirmed? */
  confirmed: boolean;
  /** Days between booking (approximated by last source stamp) and the visit. */
  leadTimeDays: number;
  /** New to the practice (first visit missing or within 120 days). */
  isNewPatient: boolean;
  /** Local start hour (0–23) of the upcoming appointment. */
  startHour: number;
  /** Local day of week (0 Sunday … 6 Saturday). */
  dayOfWeek: number;
}

export interface NoShowFactor {
  key: string;
  /** Contribution to the total risk (already weighted). */
  weight: number;
  detail: string;
}

export interface NoShowScore {
  /** 0..1, rounded to 2 decimals. */
  risk: number;
  /** Non-zero contributions only, largest first — the explanation trail. */
  factors: NoShowFactor[];
}

// risk = 0.30·past_noshow_rate + 0.20·no_prior_confirmation + 0.15·lead_time
//      + 0.15·new_patient + 0.10·evening/monday_slot + 0.10·prior_late_cancels
export function computeNoShowRisk(f: NoShowFeatures): NoShowScore {
  const factors: NoShowFactor[] = [];

  const noShowRate = f.pastAppointments > 0 ? f.pastNoShows / f.pastAppointments : 0;
  if (noShowRate > 0) {
    factors.push({
      key: "past_no_shows",
      weight: 0.3 * Math.min(1, noShowRate),
      detail: `${f.pastNoShows} prior no-show${f.pastNoShows === 1 ? "" : "s"} in ${f.pastAppointments} visits`
    });
  }
  if (!f.confirmed) {
    factors.push({ key: "unconfirmed", weight: 0.2, detail: "appointment not confirmed" });
  }
  const lead = f.leadTimeDays >= 30 ? 1 : f.leadTimeDays >= 14 ? 0.6 : f.leadTimeDays >= 7 ? 0.3 : 0;
  if (lead > 0) {
    factors.push({
      key: "lead_time",
      weight: 0.15 * lead,
      detail: `booked ~${Math.round(f.leadTimeDays)} days ahead`
    });
  }
  if (f.isNewPatient) {
    factors.push({ key: "new_patient", weight: 0.15, detail: "new patient (first visit <120 days)" });
  }
  if (f.startHour >= 16 || f.dayOfWeek === 1) {
    factors.push({
      key: "slot",
      weight: 0.1,
      detail: f.startHour >= 16 ? "evening slot" : "Monday slot"
    });
  }
  if (f.priorLateCancels > 0) {
    factors.push({
      key: "late_cancels",
      weight: 0.1 * Math.min(1, f.priorLateCancels / 2),
      detail: `${f.priorLateCancels} prior late cancel${f.priorLateCancels === 1 ? "" : "s"}`
    });
  }

  factors.sort((a, b) => b.weight - a.weight);
  const risk = Math.round(factors.reduce((s, x) => s + x.weight, 0) * 100) / 100;
  return { risk: Math.min(1, risk), factors };
}
