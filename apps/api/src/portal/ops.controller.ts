import {
  BadRequestException, Body, Controller, Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { PortalService } from "./portal.service";
import { AuditService } from "../audit.service";
import { TemporalService } from "../temporal/temporal.service";

const AGENTS_URL = () => process.env.AGENTS_URL ?? "http://localhost:8000";

// Operator-triggered agent workflows and clinical AI endpoints.
@Controller("portal/ops")
@UseGuards(JwtGuard)
export class OpsController {
  constructor(
    private portal: PortalService,
    private audit: AuditService,
    private temporal: TemporalService
  ) {}

  @Post("recall-campaign")
  async recallCampaign(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
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

  @Post("previsit/:locationId/:patientSourceId")
  async previsit(
    @CurrentUser() user: SessionUser,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Param("patientSourceId", ParseIntPipe) patientSourceId: number
  ) {
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
