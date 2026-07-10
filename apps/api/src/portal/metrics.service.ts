import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gt, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import {
  appointments, claimDenials, claims, dailyLocationMetrics, operatories,
  patients, payments, procedureCodes, procedures
} from "@dental/db";
import { DB, type Db } from "../db";
import { computeDailyMetrics, type DailyMetricFacts, type DailyMetricValues } from "./metrics";

// D1: the metrics rollup layer. Each metric's SQL lives here — the same
// definitions the billing tiles (B5) and huddle (C1) use where they overlap,
// so the runbook can reconcile all three against direct SQL. The nightly
// metricsRollup workflow calls rollupRange; the analytics UI (D2) and the
// insights agent (D3) only ever read the daily_location_metrics rows this
// service writes.
//
// Point-in-time caveat (documented in the plan): AR aging is reconstructed
// relative to the target date from claims still open today, and the
// unscheduled-treatment snapshot is as-of-run — exact for the nightly
// "yesterday" rollup, approximate for deep backfills over historical days.

const HYGIENE_CODES = ["D1110", "D1120", "D4910"];

@Injectable()
export class MetricsService {
  private readonly log = new Logger("Metrics");

  constructor(@Inject(DB) private db: Db) {}

  /** Gather one location-day of raw facts from the canonical tables. */
  async gatherDayFacts(locationId: number, date: string): Promise<DailyMetricFacts> {
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59.999`);

    // The day's book: scheduled, completed, and broken appointments.
    const dayAppts = await this.db
      .select({
        sourceId: appointments.sourceId,
        status: appointments.status,
        minutes: appointments.minutes,
        note: appointments.note
      })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        inArray(appointments.status, ["scheduled", "complete", "broken"]),
        gte(appointments.startsAt, dayStart),
        lte(appointments.startsAt, dayEnd)
      ));
    const broken = dayAppts.filter((a) => a.status === "broken");
    // A3 convention: a no-show is a broken appointment with a "no-show" note.
    const noshowCount = broken.filter((a) => /no-show/i.test(a.note)).length;
    const bookedMinutes = dayAppts
      .filter((a) => a.status !== "broken")
      .reduce((s, a) => s + a.minutes, 0);

    const [ops] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(operatories)
      .where(and(eq(operatories.locationId, locationId), eq(operatories.isHidden, false)));

    // Production scheduled = fees attached to the day's appointments (what was
    // on the books, including what broke); completed = fees performed that day.
    const [schedProd] = await this.db
      .select({ v: sql<number>`coalesce(sum(${procedures.fee}), 0)` })
      .from(procedures)
      .innerJoin(appointments, and(
        eq(appointments.locationId, procedures.locationId),
        eq(appointments.sourceId, procedures.appointmentSourceId)))
      .where(and(
        eq(procedures.locationId, locationId),
        gt(procedures.appointmentSourceId, 0),
        inArray(appointments.status, ["scheduled", "complete", "broken"]),
        gte(appointments.startsAt, dayStart),
        lte(appointments.startsAt, dayEnd)
      ));
    const [complProd] = await this.db
      .select({ v: sql<number>`coalesce(sum(${procedures.fee}), 0)` })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.status, "complete"),
        eq(procedures.procDate, date)
      ));

    const [coll] = await this.db
      .select({ v: sql<number>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(and(eq(payments.locationId, locationId), eq(payments.payDate, date)));

    // Hygiene reappointment: of the day's hygiene patients, who left with (or
    // has since booked) an appointment after that day.
    const hygienePatients = await this.db
      .selectDistinct({ pat: procedures.patientSourceId })
      .from(procedures)
      .innerJoin(procedureCodes, and(
        eq(procedureCodes.locationId, procedures.locationId),
        eq(procedureCodes.sourceId, procedures.codeSourceId)))
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.status, "complete"),
        eq(procedures.procDate, date),
        inArray(procedureCodes.procCode, HYGIENE_CODES)
      ));
    const hygieneIds = hygienePatients.map((h) => h.pat);
    let hygieneReappointed = 0;
    if (hygieneIds.length > 0) {
      const [re] = await this.db
        .select({ n: sql<number>`count(distinct ${appointments.patientSourceId})::int` })
        .from(appointments)
        .where(and(
          eq(appointments.locationId, locationId),
          eq(appointments.status, "scheduled"),
          gt(appointments.startsAt, dayEnd),
          inArray(appointments.patientSourceId, hygieneIds)
        ));
      hygieneReappointed = re?.n ?? 0;
    }

    // Unscheduled treatment value — same query as the Overview tile / huddle.
    const withUpcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        eq(appointments.status, "scheduled"),
        sql`${appointments.startsAt} > now()`
      ));
    const [unsched] = await this.db
      .select({ v: sql<number>`coalesce(sum(${procedures.fee}), 0)` })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.status, "planned"),
        notInArray(procedures.patientSourceId, withUpcoming)
      ));

    // AR aging as of the target date (open claims, value = fee − paid,
    // age = days since dateSent with dateService fallback — B5's definition).
    const openClaims = await this.db
      .select({
        dateSent: claims.dateSent,
        dateService: claims.dateService,
        claimFee: claims.claimFee,
        insPayAmt: claims.insPayAmt
      })
      .from(claims)
      .where(and(eq(claims.locationId, locationId), inArray(claims.status, ["sent", "waiting"])));
    const asOf = new Date(`${date}T00:00:00`).getTime();
    const openClaimAges = openClaims
      .map((c) => {
        const ref = c.dateSent ?? c.dateService;
        if (!ref) return null;
        const age = Math.floor((asOf - new Date(`${ref}T00:00:00`).getTime()) / 86_400_000);
        if (age < 0) return null; // not yet sent as of this metric date
        return { ageDays: age, value: c.claimFee - c.insPayAmt };
      })
      .filter((c): c is { ageDays: number; value: number } => c !== null);

    // Denials the platform recorded that day (B4's claim_denials rows).
    const [denials] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(claimDenials)
      .where(and(
        eq(claimDenials.locationId, locationId),
        gte(claimDenials.createdAt, dayStart),
        lte(claimDenials.createdAt, dayEnd)
      ));

    const [newPats] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(patients)
      .where(and(eq(patients.locationId, locationId), eq(patients.firstVisit, date)));

    // Case acceptance: procedures presented (planned or performed) that day;
    // accepted = performed, or still-planned with a visit booked afterwards.
    const dayCases = await this.db
      .select({ status: procedures.status, patientSourceId: procedures.patientSourceId })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.procDate, date),
        inArray(procedures.status, ["planned", "complete"])
      ));
    const plannedPatients = [...new Set(dayCases.filter((c) => c.status === "planned").map((c) => c.patientSourceId))];
    const bookedAfter = new Set<number>();
    if (plannedPatients.length > 0) {
      const rows = await this.db
        .selectDistinct({ pat: appointments.patientSourceId })
        .from(appointments)
        .where(and(
          eq(appointments.locationId, locationId),
          eq(appointments.status, "scheduled"),
          gt(appointments.startsAt, dayEnd),
          inArray(appointments.patientSourceId, plannedPatients)
        ));
      for (const r of rows) bookedAfter.add(r.pat);
    }
    const casesAccepted = dayCases.filter(
      (c) => c.status === "complete" || bookedAfter.has(c.patientSourceId)
    ).length;

    return {
      date,
      appointmentsCount: dayAppts.length,
      cancellationCount: broken.length - noshowCount,
      noshowCount,
      bookedMinutes,
      operatoryCount: ops?.n ?? 0,
      productionScheduled: Number(schedProd?.v ?? 0),
      productionCompleted: Number(complProd?.v ?? 0),
      collections: Number(coll?.v ?? 0),
      hygienePatientsSeen: hygieneIds.length,
      hygienePatientsReappointed: hygieneReappointed,
      unscheduledTreatmentValue: Number(unsched?.v ?? 0),
      openClaimAges,
      denialCount: denials?.n ?? 0,
      newPatients: newPats?.n ?? 0,
      casesPresented: dayCases.length,
      casesAccepted
    };
  }

  /** Compute one location-day and upsert it (idempotent — reruns overwrite). */
  async rollupDay(orgId: number, locationId: number, date: string): Promise<DailyMetricValues> {
    const facts = await this.gatherDayFacts(locationId, date);
    const m = computeDailyMetrics(facts);
    await this.db.insert(dailyLocationMetrics).values({
      orgId,
      locationId,
      date: m.date,
      productionScheduled: m.productionScheduled,
      productionCompleted: m.productionCompleted,
      collections: m.collections,
      cancellationCount: m.cancellationCount,
      noshowCount: m.noshowCount,
      brokenRate: m.brokenRate,
      hygieneReappointmentRate: m.hygieneReappointmentRate,
      unscheduledTreatmentValue: m.unscheduledTreatmentValue,
      ar0_30: m.ar0_30,
      ar31_60: m.ar31_60,
      ar61_90: m.ar61_90,
      ar90Plus: m.ar90Plus,
      openClaimsValue: m.openClaimsValue,
      denialCount: m.denialCount,
      newPatients: m.newPatients,
      caseAcceptanceRate: m.caseAcceptanceRate,
      appointmentsCount: m.appointmentsCount,
      chairUtilization: m.chairUtilization
    }).onConflictDoUpdate({
      target: [dailyLocationMetrics.locationId, dailyLocationMetrics.date],
      set: {
        productionScheduled: m.productionScheduled,
        productionCompleted: m.productionCompleted,
        collections: m.collections,
        cancellationCount: m.cancellationCount,
        noshowCount: m.noshowCount,
        brokenRate: m.brokenRate,
        hygieneReappointmentRate: m.hygieneReappointmentRate,
        unscheduledTreatmentValue: m.unscheduledTreatmentValue,
        ar0_30: m.ar0_30,
        ar31_60: m.ar31_60,
        ar61_90: m.ar61_90,
        ar90Plus: m.ar90Plus,
        openClaimsValue: m.openClaimsValue,
        denialCount: m.denialCount,
        newPatients: m.newPatients,
        caseAcceptanceRate: m.caseAcceptanceRate,
        appointmentsCount: m.appointmentsCount,
        chairUtilization: m.chairUtilization
      }
    });
    return m;
  }

  /**
   * Roll up the N days ending yesterday (nightly cron: days=1; backfill mode:
   * up to 90 — overwrites the bootstrap's synthetic rows with canonical data).
   */
  async rollupRange(orgId: number, locationId: number, days: number): Promise<{ days: number; from: string; to: string }> {
    const n = Math.max(1, Math.min(90, Math.floor(days)));
    const pad = (x: number) => String(x).padStart(2, "0");
    const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);

    let from = "";
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(yesterday);
      d.setDate(d.getDate() - i);
      const dateStr = localDate(d);
      if (!from) from = dateStr;
      await this.rollupDay(orgId, locationId, dateStr);
    }
    const to = localDate(yesterday);
    this.log.log(`rolled up ${n} day(s) ${from}..${to} for location ${locationId}`);
    return { days: n, from, to };
  }
}
