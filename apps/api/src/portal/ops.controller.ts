import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { ALL_ROLES, assertRole } from "../auth/roles";
import { PortalService } from "./portal.service";
import { AnalyticsService } from "./analytics.service";
import { AuditService } from "../audit.service";
import { AgentsClient } from "../temporal/agents.client";
import { TemporalService } from "../temporal/temporal.service";
import { EmailService } from "../email/email.service";
import { huddleDigest } from "../email/templates";

const AGENTS_URL = () => process.env.AGENTS_URL ?? "http://localhost:8000";

// Operator-triggered agent workflows and clinical AI endpoints.
@Controller("portal/ops")
@UseGuards(JwtGuard)
export class OpsController {
  constructor(
    private portal: PortalService,
    private analytics: AnalyticsService,
    private audit: AuditService,
    private agents: AgentsClient,
    private temporal: TemporalService,
    private email: EmailService
  ) {}

  @Post("recall-campaign")
  async recallCampaign(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertRole(user, ...ALL_ROLES); // G4: campaign trigger — front desk's job
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `recall-${loc.key}-${randomUUID().slice(0, 8)}`;
    await this.temporal.startWorkflow("recallCampaign", workflowId, {
      orgId: user.orgId, locationId: loc.id, siteKey: loc.key, batchSize: 5
    });
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.recallCampaign", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }

  @Post("claim-followup")
  async claimFollowUp(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertRole(user, ...ALL_ROLES); // G4: billing ops — all in-location roles
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `claimfu-${loc.key}-${randomUUID().slice(0, 8)}`;
    await this.temporal.startWorkflow("claimFollowUp", workflowId, {
      orgId: user.orgId, locationId: loc.id, siteKey: loc.key
    });
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.claimFollowUp", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }

  // --- Phase C ops workflows -------------------------------------------------

  // C1: manual huddle trigger (the cron fires at 06:00; demos shouldn't wait).
  @Post("huddle")
  async runHuddle(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertRole(user, ...ALL_ROLES); // G4: read-only workflow — all roles
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `huddle-manual-${loc.key}-${randomUUID().slice(0, 8)}`;
    try {
      await this.temporal.startWorkflow("morningHuddle", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.morningHuddle", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }

  // C1: read the digest for a date (default today). Wrapped because a bare
  // null serializes to an empty body, which JSON clients can't distinguish
  // from a failed request.
  @Get("huddle")
  async getHuddle(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("date") date?: string
  ) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return { digest: await this.portal.huddleDigest(loc.id, date) };
  }

  // E3: email today's huddle digest to the requesting user (staff-facing send
  // — the huddle_digest template, no patient policy involved).
  @Post("huddle-email")
  async emailHuddle(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("date") date?: string
  ) {
    assertRole(user, ...ALL_ROLES); // G4: staff-facing send to self — all roles
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const digest = await this.portal.huddleDigest(loc.id, date);
    if (!digest) throw new BadRequestException("No huddle digest for that date — generate one first");
    const result = await this.email.sendToStaff({
      orgId: user.orgId,
      locationId: loc.id,
      toEmail: user.email,
      email: huddleDigest({
        locationName: loc.name,
        date: digest.date,
        narrative: digest.narrative,
        actionItems: (digest.actionItems as Array<{ title: string; priority: string }>) ?? []
      }),
      actor: user.email,
      purpose: `huddle digest ${digest.date} emailed to self`
    });
    return { ok: true, outcome: result.outcome };
  }

  // C2: manual reminder sweep (the cron fires at 16:00 for T+1).
  @Post("reminder-sweep")
  async reminderSweep(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertRole(user, ...ALL_ROLES); // G4: campaign trigger — front desk's job
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `remind-manual-${loc.key}-${randomUUID().slice(0, 8)}`;
    try {
      await this.temporal.startWorkflow("reminderSweep", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.reminderSweep", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }

  // C5: manual unscheduled-treatment outreach (the cron fires at 07:00).
  @Post("treatment-outreach")
  async treatmentOutreach(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    assertRole(user, ...ALL_ROLES); // G4: campaign trigger — front desk's job
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `outreach-manual-${loc.key}-${randomUUID().slice(0, 8)}`;
    try {
      await this.temporal.startWorkflow("treatmentOutreach", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key, batchSize: 5
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.treatmentOutreach", resource: "workflow", resourceId: workflowId
    });
    return { workflowId };
  }

  // --- Phase D ---------------------------------------------------------------

  // D1: manual metrics rollup (the cron fires at 02:30 computing yesterday).
  // days>1 backfills, overwriting the bootstrap's synthetic rows with
  // canonical numbers — capped at 90 by the service.
  @Post("metrics-rollup")
  async metricsRollup(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("days") days?: string
  ) {
    const n = Math.max(1, Math.min(90, Number(days) || 1));
    // G4: a multi-day backfill overwrites metric history (incl. the synthetic
    // bootstrap rows) — that's config-destructive, so admin only. The 1-day
    // recompute is the nightly cron's job and stays open to all roles.
    if (n > 1) assertRole(user, "admin");
    else assertRole(user, ...ALL_ROLES);
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const workflowId = `metrics-manual-${loc.key}-${randomUUID().slice(0, 8)}`;
    try {
      await this.temporal.startWorkflow("metricsRollup", workflowId, {
        orgId: user.orgId, locationId: loc.id, siteKey: loc.key, days: n
      });
    } catch (err) {
      throw new BadRequestException(`could not start workflow: ${(err as Error).message}`);
    }
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "workflow.started.metricsRollup", resource: "workflow", resourceId: workflowId,
      purpose: `${n} day(s)`
    });
    return { workflowId, days: n };
  }

  // D3: owner insights — "why did site B underperform this week?" answered
  // only from daily_location_metrics deltas. Deterministic comparison windows
  // come from AnalyticsService (org-wide gate applies); the agent narrates,
  // the z-score template answers when no LLM is available.
  @Post("insights")
  async insights(
    @CurrentUser() user: SessionUser,
    @Body() body: { question?: string; windowDays?: number }
  ) {
    // G4: org-wide read — insightWindows applies assertOrgWide; stated here
    // for grep-ability. No per-role gate beyond that.
    if (!body.question?.trim()) throw new BadRequestException("question required");
    const windows = await this.analytics.insightWindows(user, body.windowDays ?? 7);
    const result = await this.agents.draftInsights({
      question: body.question.trim(),
      ...windows
    });
    await this.audit.log({
      orgId: user.orgId, locationId: null, actorType: "agent", actor: "agent:insights",
      action: "analytics.insights", resource: "daily_location_metrics",
      resourceId: windows.currentRange,
      purpose: `question from ${user.email}: ${body.question.trim().slice(0, 120)}`
    });
    return {
      ...result,
      windowDays: windows.windowDays,
      currentRange: windows.currentRange,
      previousRange: windows.previousRange
    };
  }

  @Post("previsit/:locationId/:patientSourceId")
  async previsit(
    @CurrentUser() user: SessionUser,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Param("patientSourceId", ParseIntPipe) patientSourceId: number
  ) {
    assertRole(user, ...ALL_ROLES); // G4: clinical read (audited) — all roles
    const loc = await this.portal.resolveLocation(user, locationId);
    // Make sure this location's notes are embedded, then summarize.
    await fetch(`${AGENTS_URL()}/clinical/embed?locationId=${loc.id}`, { method: "POST" })
      .catch(() => {});
    const res = await fetch(`${AGENTS_URL()}/clinical/previsit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId: loc.id, patientSourceId }),
      signal: AbortSignal.timeout(120_000)
    });
    if (!res.ok) throw new BadRequestException(`agents service: HTTP ${res.status}`);
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "agent", actor: "agent:clinical",
      action: "phi.read.previsit_summary", resource: "patient",
      resourceId: String(patientSourceId), purpose: `requested by ${user.email}`
    });
    return res.json();
  }

  @Post("chart-search")
  async chartSearch(
    @CurrentUser() user: SessionUser,
    @Body() body: { locationId?: number; query?: string }
  ) {
    assertRole(user, ...ALL_ROLES); // G4: clinical read (audited) — all roles
    if (!body.query?.trim()) throw new BadRequestException("query required");
    const loc = await this.portal.resolveLocation(user, body.locationId);
    await fetch(`${AGENTS_URL()}/clinical/embed?locationId=${loc.id}`, { method: "POST" })
      .catch(() => {});
    const res = await fetch(`${AGENTS_URL()}/clinical/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locationId: loc.id, query: body.query, limit: 8 }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!res.ok) throw new BadRequestException(`agents service: HTTP ${res.status}`);
    await this.audit.log({
      orgId: user.orgId, locationId: loc.id, actorType: "user", actor: user.email,
      action: "phi.read.semantic_chart_search", resource: "note", resourceId: body.query
    });
    return res.json();
  }
}
