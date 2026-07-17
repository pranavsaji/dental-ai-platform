import {
  BadRequestException, Controller, Get, Inject, NotFoundException, Param, ParseIntPipe,
  Post, Query, UseGuards
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { claims, patients, procedures } from "@dental/db";
import { DB, type Db } from "../db";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { assertCan } from "../auth/roles";
import { AuditService } from "../audit.service";
import { PortalService } from "./portal.service";
import { BillingService } from "./billing.service";
import { TemporalService } from "../temporal/temporal.service";
import { EmailService } from "../email/email.service";
import { statementNotice } from "../email/templates";

// Billing worklist API (B5): everything the billing team needs to work AR,
// denials, pre-auths, and eligibility exceptions without touching the PMS.
// All reads resolve the location first (tenancy) and act-surfaces are audited.
@Controller("portal/billing")
@UseGuards(JwtGuard)
export class BillingController {
  constructor(
    @Inject(DB) private db: Db,
    private portal: PortalService,
    private billing: BillingService,
    private audit: AuditService,
    private temporal: TemporalService,
    private email: EmailService
  ) {}

  // E3: email the patient a statement/balance notice (versioned template,
  // policy-gated outreach — consent, quiet hours, and frequency caps apply).
  @Post("statement-email/:patientSourceId")
  async statementEmail(
    @CurrentUser() user: SessionUser,
    @Param("patientSourceId", ParseIntPipe) patientSourceId: number,
    @Query("locationId") locationId?: string
  ) {
    assertCan(user, "statements.send"); // patient-facing balance notice
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const [pat] = await this.db
      .select({ firstName: patients.firstName })
      .from(patients)
      .where(and(eq(patients.locationId, loc.id), eq(patients.sourceId, patientSourceId)));
    if (!pat) throw new NotFoundException("Patient not found");
    const [ar] = await this.db
      .select({ value: sql<number>`coalesce(sum(${claims.claimFee} - ${claims.insPayAmt}), 0)::float` })
      .from(claims)
      .where(and(
        eq(claims.locationId, loc.id),
        eq(claims.patientSourceId, patientSourceId),
        sql`${claims.status} in ('sent', 'waiting')`
      ));
    const [lastVisit] = await this.db
      .select({ procDate: procedures.procDate })
      .from(procedures)
      .where(and(
        eq(procedures.locationId, loc.id),
        eq(procedures.patientSourceId, patientSourceId),
        eq(procedures.status, "complete")
      ))
      .orderBy(desc(procedures.procDate))
      .limit(1);
    const result = await this.email.sendToPatient({
      orgId: user.orgId,
      locationId: loc.id,
      patientSourceId,
      email: statementNotice({
        locationName: loc.name,
        patientFirst: pat.firstName,
        pendingInsurance: Math.max(0, ar?.value ?? 0),
        lastVisit: lastVisit?.procDate ?? null
      }),
      workflowId: null,
      actor: user.email,
      purpose: "statement notice requested from patient chart",
      kind: "outreach"
    });
    return { ok: true, outcome: result.outcome, reason: result.reason ?? null };
  }

  @Get("summary")
  async summary(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.summary(user.orgId, loc.id);
  }

  @Get("claims")
  async claims(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("bucket") bucket?: string,
    @Query("sort") sort?: string
  ) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listClaims(loc.id, { bucket, sort });
  }

  @Get("denials")
  async denials(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listDenials(loc.id);
  }

  @Get("preauths")
  async preauths(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listPreauths(loc.id);
  }

  // Unscheduled treatment backlog (C5): the revenue-recovery worklist.
  @Get("unscheduled")
  async unscheduled(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listUnscheduledTreatment(loc.id);
  }

  // G3: payments ledger — the direct read surface for the synced payments
  // entity. Summary reconciles to D1's collections for the same range.
  @Get("payments")
  async payments(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("days") days?: string,
    @Query("type") type?: string
  ) {
    assertCan(user, "billing.read");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const n = Math.max(1, Math.min(365, Number(days) || 30));
    const t = type === "insurance" || type === "patient" ? type : undefined;
    return this.billing.listPayments(loc.id, n, t);
  }

  // Freshest eligibility verdict per patient — powers the /schedule badge
  // column and the /billing exceptions strip.
  @Get("eligibility")
  async eligibility(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("patients") patientsCsv?: string
  ) {
    assertCan(user, "eligibility.read"); // schedule badges need front desk + provider
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const ids = patientsCsv
      ? patientsCsv.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0)
      : undefined;
    return this.billing.eligibilityByPatient(loc.id, ids);
  }

  // Per-claim follow-up (B5): starts claimFollowUp pinned to exactly this
  // claim — today's ops endpoint lets the agent pick its own.
  @Post("claims/:sourceId/follow-up")
  async followUp(
    @CurrentUser() user: SessionUser,
    @Param("sourceId", ParseIntPipe) sourceId: number,
    @Query("locationId") locationId?: string
  ) {
    assertCan(user, "billing.act");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `claimfu-${loc.key}-c${sourceId}-${randomUUID().slice(0, 6)}`;
    try {
      await this.temporal.startWorkflow("claimFollowUp", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key, targetClaimSourceId: sourceId
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.claimFollowUp", resource: "claim",
      resourceId: String(sourceId), purpose: "targeted follow-up from billing worklist"
    });
    return { workflowId };
  }

  // Manual eligibility sweep (B2): the demo/verification trigger for the
  // nightly cron. Runs the same insuranceVerification workflow.
  @Post("eligibility-sweep")
  async eligibilitySweep(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertCan(user, "billing.act");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `elig-manual-${loc.key}-${randomUUID().slice(0, 8)}`;
    try {
      await this.temporal.startWorkflow("insuranceVerification", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key, daysAhead: 3
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.insuranceVerification", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }
}
