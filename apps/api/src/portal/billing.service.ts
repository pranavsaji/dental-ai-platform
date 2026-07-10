import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  claimDenials, claims, eligibilityChecks, insPlans, patients, preauths
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
