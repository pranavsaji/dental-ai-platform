import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, gte, inArray, lte, notInArray, sql } from "drizzle-orm";
import {
  appointments, claimDenials, claims, commLogs, eligibilityChecks, insPlans,
  patients, payments, preauths, procedureCodes, procedures
} from "@dental/db";
import { DB, type Db } from "../db";

// Billing worklist reads (B5). Tenancy is enforced by the controller
// resolving the location first; every query here is location-scoped.
//
// AR definition: outstanding insurance claims (status sent | waiting),
// value = claimFee - insPayAmt, bucketed by days since dateSent (dateService
// as fallback). The runbook reconciles the tiles against direct SQL.

export interface BillingClaimRow {
  sourceId: number;
  patientSourceId: number;
  patientName: string;
  carrierName: string;
  dateService: string | null;
  dateSent: string | null;
  status: string;
  claimFee: number;
  insPayEst: number;
  insPayAmt: number;
  carcCodes: string;
  ageDays: number;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  priority: number;
}

function ageDays(dateSent: string | null, dateService: string | null): number {
  const ref = dateSent ?? dateService;
  if (!ref) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(ref).getTime()) / 86_400_000));
}

function bucketOf(age: number): BillingClaimRow["bucket"] {
  if (age <= 30) return "0-30";
  if (age <= 60) return "31-60";
  if (age <= 90) return "61-90";
  return "90+";
}

@Injectable()
export class BillingService {
  constructor(@Inject(DB) private db: Db) {}

  /** Open (unadjudicated) claims with patient/carrier context + priority score. */
  private async openClaims(locationId: number): Promise<BillingClaimRow[]> {
    const rows = await this.db
      .select({
        sourceId: claims.sourceId,
        patientSourceId: claims.patientSourceId,
        dateService: claims.dateService,
        dateSent: claims.dateSent,
        status: claims.status,
        claimFee: claims.claimFee,
        insPayEst: claims.insPayEst,
        insPayAmt: claims.insPayAmt,
        carcCodes: claims.carcCodes,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        carrierName: insPlans.carrierName
      })
      .from(claims)
      .leftJoin(patients, and(
        eq(patients.locationId, claims.locationId),
        eq(patients.sourceId, claims.patientSourceId)))
      .leftJoin(insPlans, and(
        eq(insPlans.locationId, claims.locationId),
        eq(insPlans.sourceId, claims.planSourceId)))
      .where(and(eq(claims.locationId, locationId), inArray(claims.status, ["sent", "waiting"])))
      .limit(500);

    // Pre-auth-blocked patients (payer wants something / said no): open claims
    // for them get a priority bump — that block is often what stalls payment.
    const blocked = await this.db
      .select({ patientSourceId: preauths.patientSourceId })
      .from(preauths)
      .where(and(eq(preauths.locationId, locationId), inArray(preauths.status, ["more_info", "denied"])));
    const blockedPatients = new Set(blocked.map((b) => b.patientSourceId));

    return rows.map((r) => {
      const age = ageDays(r.dateSent, r.dateService);
      const denied = r.carcCodes.trim() !== "";
      const preauthBlocked = blockedPatients.has(r.patientSourceId);
      return {
        sourceId: r.sourceId,
        patientSourceId: r.patientSourceId,
        patientName: `${r.patientFirst ?? ""} ${r.patientLast ?? ""}`.trim() || "Unknown",
        carrierName: r.carrierName ?? "Unknown carrier",
        dateService: r.dateService,
        dateSent: r.dateSent,
        status: r.status,
        claimFee: r.claimFee,
        insPayEst: r.insPayEst,
        insPayAmt: r.insPayAmt,
        carcCodes: r.carcCodes,
        ageDays: age,
        bucket: bucketOf(age),
        // Deterministic, explained in-UI: age + value + denial + pre-auth block.
        priority: Math.round(age * 1.0 + r.claimFee / 100 + (denied ? 40 : 0) + (preauthBlocked ? 25 : 0))
      };
    });
  }

  async summary(orgId: number, locationId: number) {
    const open = await this.openClaims(locationId);
    const buckets = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 } as Record<string, number>;
    for (const c of open) buckets[c.bucket] += c.claimFee - c.insPayAmt;

    const [denialAgg] = await this.db
      .select({ n: sql<number>`count(*)::int`, openAppeals: sql<number>`count(*) filter (where ${claimDenials.appealStatus} in ('drafted','pending_approval','sent'))::int` })
      .from(claimDenials)
      .where(eq(claimDenials.locationId, locationId));

    // Latest check per (patient, plan) — only the freshest verdict counts.
    const exceptions = await this.db.execute(sql`
      select count(*)::int as n from (
        select distinct on (patient_source_id, plan_source_id) status
        from eligibility_checks
        where location_id = ${locationId}
        order by patient_source_id, plan_source_id, checked_at desc
      ) latest where status in ('inactive', 'attention', 'failed')
    `);

    const [preauthAgg] = await this.db
      .select({
        open: sql<number>`count(*) filter (where ${preauths.status} in ('pending_approval','submitted','more_info'))::int`,
        needsInfo: sql<number>`count(*) filter (where ${preauths.status} = 'more_info')::int`
      })
      .from(preauths)
      .where(eq(preauths.locationId, locationId));

    return {
      ar: {
        "0-30": Math.round(buckets["0-30"]),
        "31-60": Math.round(buckets["31-60"]),
        "61-90": Math.round(buckets["61-90"]),
        "90+": Math.round(buckets["90+"])
      },
      openClaims: open.length,
      openClaimsValue: Math.round(open.reduce((s, c) => s + c.claimFee - c.insPayAmt, 0)),
      denialCount: denialAgg?.n ?? 0,
      openAppeals: denialAgg?.openAppeals ?? 0,
      eligibilityExceptions: Number((exceptions as any).rows?.[0]?.n ?? 0),
      openPreauths: preauthAgg?.open ?? 0,
      preauthsNeedingInfo: preauthAgg?.needsInfo ?? 0
    };
  }

  async listClaims(locationId: number, filters: { bucket?: string; sort?: string }) {
    let rows = await this.openClaims(locationId);
    if (filters.bucket) rows = rows.filter((c) => c.bucket === filters.bucket);
    rows.sort(filters.sort === "age"
      ? (a, b) => b.ageDays - a.ageDays
      : filters.sort === "fee"
        ? (a, b) => b.claimFee - a.claimFee
        : (a, b) => b.priority - a.priority);
    return rows.slice(0, 200);
  }

  async listDenials(locationId: number) {
    return this.db
      .select({
        id: claimDenials.id,
        claimSourceId: claimDenials.claimSourceId,
        patientSourceId: claimDenials.patientSourceId,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        carcCodes: claimDenials.carcCodes,
        category: claimDenials.category,
        appealable: claimDenials.appealable,
        agentSummary: claimDenials.agentSummary,
        appealStatus: claimDenials.appealStatus,
        usedLlm: claimDenials.usedLlm,
        createdAt: claimDenials.createdAt,
        resolvedAt: claimDenials.resolvedAt
      })
      .from(claimDenials)
      .leftJoin(patients, and(
        eq(patients.locationId, claimDenials.locationId),
        eq(patients.sourceId, claimDenials.patientSourceId)))
      .where(eq(claimDenials.locationId, locationId))
      .orderBy(desc(claimDenials.createdAt))
      .limit(100);
  }

  async listPreauths(locationId: number) {
    return this.db
      .select({
        id: preauths.id,
        patientSourceId: preauths.patientSourceId,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        procCode: preauths.procCode,
        fee: preauths.fee,
        status: preauths.status,
        missingItem: preauths.missingItem,
        payerReference: preauths.payerReference,
        createdAt: preauths.createdAt,
        resolvedAt: preauths.resolvedAt
      })
      .from(preauths)
      .leftJoin(patients, and(
        eq(patients.locationId, preauths.locationId),
        eq(patients.sourceId, preauths.patientSourceId)))
      .where(eq(preauths.locationId, locationId))
      .orderBy(desc(preauths.createdAt))
      .limit(100);
  }

  /**
   * Unscheduled treatment backlog (C5): planned procedures whose patient has
   * no future appointment, ranked by fee × age — the same inventory the
   * treatmentOutreach workflow works from, plus last-contact context.
   */
  async listUnscheduledTreatment(locationId: number) {
    const withUpcoming = this.db
      .select({ pat: appointments.patientSourceId })
      .from(appointments)
      .where(and(
        eq(appointments.locationId, locationId),
        eq(appointments.status, "scheduled"),
        sql`${appointments.startsAt} > now()`
      ));
    const rows = await this.db
      .select({
        procedureSourceId: procedures.sourceId,
        patientSourceId: procedures.patientSourceId,
        procDate: procedures.procDate,
        fee: procedures.fee,
        toothNum: procedures.toothNum,
        procCode: procedureCodes.procCode,
        description: procedureCodes.description,
        patientFirst: patients.firstName,
        patientLast: patients.lastName
      })
      .from(procedures)
      .innerJoin(patients, and(
        eq(patients.locationId, procedures.locationId),
        eq(patients.sourceId, procedures.patientSourceId)))
      .leftJoin(procedureCodes, and(
        eq(procedureCodes.locationId, procedures.locationId),
        eq(procedureCodes.sourceId, procedures.codeSourceId)))
      .where(and(
        eq(procedures.locationId, locationId),
        eq(procedures.status, "planned"),
        eq(patients.status, "active"),
        notInArray(procedures.patientSourceId, withUpcoming)
      ))
      .limit(300);

    const patIds = [...new Set(rows.map((r) => r.patientSourceId))];
    const lastContact = new Map<number, Date>();
    if (patIds.length > 0) {
      const contacts = await this.db
        .select({
          patientSourceId: commLogs.patientSourceId,
          last: sql<string>`max(${commLogs.happenedAt})`
        })
        .from(commLogs)
        .where(and(eq(commLogs.locationId, locationId), inArray(commLogs.patientSourceId, patIds)))
        .groupBy(commLogs.patientSourceId);
      for (const c of contacts) lastContact.set(c.patientSourceId, new Date(c.last));
    }

    const now = Date.now();
    return rows
      .map((r) => {
        const age = r.procDate ? Math.max(1, Math.floor((now - new Date(r.procDate).getTime()) / 86_400_000)) : 1;
        return {
          procedureSourceId: r.procedureSourceId,
          patientSourceId: r.patientSourceId,
          patientName: `${r.patientFirst} ${r.patientLast}`.trim(),
          procCode: r.procCode ?? "",
          description: r.description ?? "planned procedure",
          toothNum: r.toothNum,
          fee: r.fee,
          plannedOn: r.procDate,
          ageDays: age,
          lastContactAt: lastContact.get(r.patientSourceId)?.toISOString() ?? null,
          score: Math.round(r.fee * age)
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
  }

  /**
   * Payments ledger (G3): the direct read surface for the 13th synced entity.
   * A ledger, not analytics — rows by payDate with patient context, plus a
   * summary that reconciles to D1's collections definition for the same range
   * (sum of payment.amount by pay_date — exactly what rollupDay gathers).
   */
  async listPayments(locationId: number, days: number, type?: "insurance" | "patient") {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    // Upper bound at today: the seeded practice pays some claims on future
    // dates — a "last N days" ledger must not show August in July.
    const until = new Date().toISOString().slice(0, 10);
    const scope = [
      eq(payments.locationId, locationId),
      gte(payments.payDate, since),
      lte(payments.payDate, until)
    ];
    // Sim payType convention (A3/A4): 1 check, 2 card, 3 cash, 4 insurance EFT.
    if (type === "insurance") scope.push(eq(payments.payType, 4));
    if (type === "patient") scope.push(sql`${payments.payType} <> 4`);

    const rows = await this.db
      .select({
        sourceId: payments.sourceId,
        patientSourceId: payments.patientSourceId,
        patientFirst: patients.firstName,
        patientLast: patients.lastName,
        payDate: payments.payDate,
        amount: payments.amount,
        payType: payments.payType,
        note: payments.note
      })
      .from(payments)
      .leftJoin(patients, and(
        eq(patients.locationId, payments.locationId),
        eq(patients.sourceId, payments.patientSourceId)))
      .where(and(...scope))
      .orderBy(desc(payments.payDate), desc(payments.sourceId))
      .limit(500);

    // Aggregate over the FULL range (rows above are display-capped at 500) so
    // the summary always reconciles with daily_location_metrics.collections.
    const [agg] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        insuranceTotal: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.payType} = 4), 0)::float`,
        patientTotal: sql<number>`coalesce(sum(${payments.amount}) filter (where ${payments.payType} <> 4), 0)::float`
      })
      .from(payments)
      .where(and(...scope));

    return {
      since,
      days,
      summary: {
        count: agg?.count ?? 0,
        total: Math.round(((agg?.insuranceTotal ?? 0) + (agg?.patientTotal ?? 0)) * 100) / 100,
        insuranceTotal: Math.round((agg?.insuranceTotal ?? 0) * 100) / 100,
        patientTotal: Math.round((agg?.patientTotal ?? 0) * 100) / 100
      },
      payments: rows.map((r) => ({
        sourceId: r.sourceId,
        patientSourceId: r.patientSourceId,
        patientName: `${r.patientFirst ?? ""} ${r.patientLast ?? ""}`.trim() || `Patient ${r.patientSourceId}`,
        payDate: r.payDate,
        amount: r.amount,
        type: r.payType === 4 ? "insurance" : "patient",
        source: r.payType === 4 ? "insurance EFT" : r.payType === 1 ? "check" : r.payType === 2 ? "card" : r.payType === 3 ? "cash" : `type ${r.payType}`,
        note: r.note
      }))
    };
  }

  /**
   * Freshest eligibility verdict per patient — as a map, for schedule badges
   * and the exceptions strip. Optionally restricted to a set of patients.
   */
  async eligibilityByPatient(locationId: number, patientSourceIds?: number[]) {
    const scope = [eq(eligibilityChecks.locationId, locationId)];
    if (patientSourceIds && patientSourceIds.length > 0) {
      scope.push(inArray(eligibilityChecks.patientSourceId, patientSourceIds));
    }
    const rows = await this.db
      .select({
        patientSourceId: eligibilityChecks.patientSourceId,
        planSourceId: eligibilityChecks.planSourceId,
        status: eligibilityChecks.status,
        summary: eligibilityChecks.summary,
        checkedAt: eligibilityChecks.checkedAt,
        expiresAt: eligibilityChecks.expiresAt
      })
      .from(eligibilityChecks)
      .where(and(...scope))
      .orderBy(desc(eligibilityChecks.checkedAt))
      .limit(1000);
    // First row per patient is the freshest (ordered desc).
    const latest = new Map<number, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.patientSourceId)) latest.set(r.patientSourceId, r);
    return [...latest.values()];
  }
}
