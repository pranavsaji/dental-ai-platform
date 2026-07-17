import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { dailyLocationMetrics, locations } from "@dental/db";
import { DB, type Db } from "../db";
import type { SessionUser } from "../auth/auth";
import { assertCan } from "../auth/roles";

// D2/D3: cross-location analytics reads. This is the platform's first
// genuinely org-wide read surface — queries scope by orgId only, so access is
// restricted to admin users who are NOT pinned to a location.
// Everything here reads only the daily_location_metrics rows D1 writes.

export interface LocationAggregate {
  locationId: number;
  key: string;
  name: string;
  productionCompleted: number;
  productionScheduled: number;
  collections: number;
  collectionRate: number; // collections ÷ completed production over the range
  appointmentsCount: number;
  cancellationCount: number;
  noshowCount: number;
  brokenRate: number; // (cancels + no-shows) ÷ appointments over the range
  newPatients: number;
  denialCount: number;
  caseAcceptanceRate: number; // mean of daily values
  chairUtilization: number; // mean of daily values
  hygieneReappointmentRate: number; // mean of daily values
  // Point-in-time from the latest row in range:
  ar0_30: number;
  ar31_60: number;
  ar61_90: number;
  ar90Plus: number;
  openClaimsValue: number;
  unscheduledTreatmentValue: number;
  latestDate: string | null;
  days: number;
}

export interface InsightsMetricDelta {
  metric: string;
  currentAvg: number;
  previousAvg: number;
  previousStd: number;
  deltaPct: number | null; // null when the previous window average is 0
  zScore: number | null; // (currentAvg − previousAvg) ÷ previousStd; null when std is 0
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const std = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};

// The metric columns the insights agent compares, window over window.
const INSIGHT_METRICS = [
  "productionCompleted", "collections", "appointmentsCount", "cancellationCount",
  "noshowCount", "brokenRate", "newPatients", "caseAcceptanceRate",
  "chairUtilization", "ar90Plus", "openClaimsValue", "unscheduledTreatmentValue",
  "denialCount"
] as const;

type MetricRow = typeof dailyLocationMetrics.$inferSelect;

@Injectable()
export class AnalyticsService {
  constructor(@Inject(DB) private db: Db) {}

  /** Org-wide gate: the owner's revenue view — admin role AND not pinned to
   *  a single location. Doctors see their own patients, not org financials. */
  assertOrgWide(user: SessionUser): void {
    assertCan(user, "analytics.read");
    if (user.locationId != null) {
      throw new ForbiddenException("Analytics requires an org-wide admin account");
    }
  }

  private localDate(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  private async orgLocations(orgId: number) {
    return this.db
      .select({ id: locations.id, key: locations.key, name: locations.name })
      .from(locations)
      .where(eq(locations.orgId, orgId));
  }

  private async rowsInRange(orgId: number, from: string, to: string): Promise<MetricRow[]> {
    return this.db
      .select()
      .from(dailyLocationMetrics)
      .where(and(
        eq(dailyLocationMetrics.orgId, orgId),
        gte(dailyLocationMetrics.date, from),
        lte(dailyLocationMetrics.date, to)
      ))
      .orderBy(asc(dailyLocationMetrics.date));
  }

  private aggregate(loc: { id: number; key: string; name: string }, rows: MetricRow[]): LocationAggregate {
    const latest = rows.length > 0 ? rows[rows.length - 1] : null;
    const sum = (f: (r: MetricRow) => number) => rows.reduce((s, r) => s + f(r), 0);
    const production = sum((r) => r.productionCompleted);
    const collections = sum((r) => r.collections);
    const appts = sum((r) => r.appointmentsCount);
    const cancels = sum((r) => r.cancellationCount);
    const noshows = sum((r) => r.noshowCount);
    return {
      locationId: loc.id,
      key: loc.key,
      name: loc.name,
      productionCompleted: Math.round(production),
      productionScheduled: Math.round(sum((r) => r.productionScheduled)),
      collections: Math.round(collections),
      collectionRate: production > 0 ? round2(collections / production) : 0,
      appointmentsCount: appts,
      cancellationCount: cancels,
      noshowCount: noshows,
      brokenRate: appts > 0 ? round4((cancels + noshows) / appts) : 0,
      newPatients: sum((r) => r.newPatients),
      denialCount: sum((r) => r.denialCount),
      caseAcceptanceRate: round4(mean(rows.map((r) => r.caseAcceptanceRate))),
      chairUtilization: round4(mean(rows.map((r) => r.chairUtilization))),
      hygieneReappointmentRate: round4(mean(rows.map((r) => r.hygieneReappointmentRate))),
      ar0_30: Math.round(latest?.ar0_30 ?? 0),
      ar31_60: Math.round(latest?.ar31_60 ?? 0),
      ar61_90: Math.round(latest?.ar61_90 ?? 0),
      ar90Plus: Math.round(latest?.ar90Plus ?? 0),
      openClaimsValue: Math.round(latest?.openClaimsValue ?? 0),
      unscheduledTreatmentValue: Math.round(latest?.unscheduledTreatmentValue ?? 0),
      latestDate: latest?.date ?? null,
      days: rows.length
    };
  }

  /** Side-by-side location comparison + org rollup for a trailing window. */
  async summary(user: SessionUser, days: number) {
    this.assertOrgWide(user);
    const n = Math.max(7, Math.min(365, Math.floor(days) || 30));
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - n);

    const locs = await this.orgLocations(user.orgId);
    const rows = await this.rowsInRange(user.orgId, this.localDate(from), this.localDate(now));
    const perLocation = locs.map((loc) =>
      this.aggregate(loc, rows.filter((r) => r.locationId === loc.id)));

    const orgProduction = perLocation.reduce((s, l) => s + l.productionCompleted, 0);
    const orgCollections = perLocation.reduce((s, l) => s + l.collections, 0);
    const org = {
      productionCompleted: orgProduction,
      collections: orgCollections,
      collectionRate: orgProduction > 0 ? round2(orgCollections / orgProduction) : 0,
      arTotal: perLocation.reduce((s, l) => s + l.ar0_30 + l.ar31_60 + l.ar61_90 + l.ar90Plus, 0),
      ar90Plus: perLocation.reduce((s, l) => s + l.ar90Plus, 0),
      unscheduledTreatmentValue: perLocation.reduce((s, l) => s + l.unscheduledTreatmentValue, 0),
      newPatients: perLocation.reduce((s, l) => s + l.newPatients, 0),
      openClaimsValue: perLocation.reduce((s, l) => s + l.openClaimsValue, 0)
    };
    return { days: n, from: this.localDate(from), to: this.localDate(now), org, locations: perLocation };
  }

  /** Daily series per location for the trend sparklines (30/90 days). */
  async trends(user: SessionUser, days: number) {
    this.assertOrgWide(user);
    const n = Math.max(7, Math.min(365, Math.floor(days) || 30));
    const now = new Date();
    const from = new Date(now);
    from.setDate(from.getDate() - n);

    const locs = await this.orgLocations(user.orgId);
    const rows = await this.rowsInRange(user.orgId, this.localDate(from), this.localDate(now));
    return {
      days: n,
      locations: locs,
      series: rows.map((r) => ({
        locationId: r.locationId,
        date: r.date,
        productionCompleted: Math.round(r.productionCompleted),
        collections: Math.round(r.collections),
        brokenRate: r.brokenRate,
        newPatients: r.newPatients,
        ar90Plus: Math.round(r.ar90Plus),
        chairUtilization: r.chairUtilization
      }))
    };
  }

  /**
   * D3: the two comparison windows the insights agent narrates — per location,
   * per metric: current-window average vs previous-window average, previous
   * std for a z-score, and the % delta. All deterministic; the agent (or the
   * template fallback) may only restate these numbers.
   */
  async insightWindows(user: SessionUser, windowDays: number) {
    this.assertOrgWide(user);
    const n = Math.max(3, Math.min(90, Math.floor(windowDays) || 7));
    const now = new Date();
    const currentFrom = new Date(now);
    currentFrom.setDate(currentFrom.getDate() - n);
    const previousFrom = new Date(now);
    previousFrom.setDate(previousFrom.getDate() - 2 * n);
    const previousTo = new Date(currentFrom);
    previousTo.setDate(previousTo.getDate() - 1);

    const locs = await this.orgLocations(user.orgId);
    const current = await this.rowsInRange(user.orgId, this.localDate(currentFrom), this.localDate(now));
    const previous = await this.rowsInRange(user.orgId, this.localDate(previousFrom), this.localDate(previousTo));

    const perLocation = locs.map((loc) => {
      const cur = current.filter((r) => r.locationId === loc.id);
      const prev = previous.filter((r) => r.locationId === loc.id);
      const metrics: InsightsMetricDelta[] = INSIGHT_METRICS.map((metric) => {
        const curVals = cur.map((r) => Number(r[metric]));
        const prevVals = prev.map((r) => Number(r[metric]));
        const currentAvg = round2(mean(curVals));
        const previousAvg = round2(mean(prevVals));
        const previousStd = round2(std(prevVals));
        return {
          metric,
          currentAvg,
          previousAvg,
          previousStd,
          deltaPct: previousAvg !== 0 ? round2(((currentAvg - previousAvg) / Math.abs(previousAvg)) * 100) : null,
          zScore: previousStd > 0 ? round2((currentAvg - previousAvg) / previousStd) : null
        };
      });
      return { locationId: loc.id, key: loc.key, name: loc.name, metrics };
    });

    return {
      windowDays: n,
      currentRange: `${this.localDate(currentFrom)}..${this.localDate(now)}`,
      previousRange: `${this.localDate(previousFrom)}..${this.localDate(previousTo)}`,
      locations: perLocation
    };
  }
}
