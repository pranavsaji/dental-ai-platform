import {
  BadRequestException, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { AuditService } from "../audit.service";
import { PortalService } from "./portal.service";
import { BillingService } from "./billing.service";
import { TemporalService } from "../temporal/temporal.service";

// Billing worklist API (B5): everything the billing team needs to work AR,
// denials, pre-auths, and eligibility exceptions without touching the PMS.
// All reads resolve the location first (tenancy) and act-surfaces are audited.
@Controller("portal/billing")
@UseGuards(JwtGuard)
export class BillingController {
  constructor(
    private portal: PortalService,
    private billing: BillingService,
    private audit: AuditService,
    private temporal: TemporalService
  ) {}

  @Get("summary")
  async summary(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
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
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listClaims(loc.id, { bucket, sort });
  }

  @Get("denials")
  async denials(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listDenials(loc.id);
  }

  @Get("preauths")
  async preauths(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listPreauths(loc.id);
  }

  // Unscheduled treatment backlog (C5): the revenue-recovery worklist.
  @Get("unscheduled")
  async unscheduled(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.billing.listUnscheduledTreatment(loc.id);
  }

  // Freshest eligibility verdict per patient — powers the /schedule badge
  // column and the /billing exceptions strip.
  @Get("eligibility")
  async eligibility(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("patients") patientsCsv?: string
  ) {
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
