import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException,
  Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { patients, proposedActions, smsMessages } from "@dental/db";
import { DB, type Db } from "../db";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { PortalService } from "./portal.service";
import { AuditService } from "../audit.service";
import { TemporalService } from "../temporal/temporal.service";
import { InboundRouterService } from "../sms/inbound-router.service";

@Controller("portal")
@UseGuards(JwtGuard)
export class ActionsController {
  constructor(
    @Inject(DB) private db: Db,
    private portal: PortalService,
    private audit: AuditService,
    private temporal: TemporalService,
    private inboundRouter: InboundRouterService
  ) {}

  // --- approval queue --------------------------------------------------------

  @Get("actions")
  async list(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.db.select().from(proposedActions)
      .where(and(eq(proposedActions.orgId, user.orgId), eq(proposedActions.locationId, loc.id)))
      .orderBy(desc(proposedActions.createdAt))
      .limit(50);
  }

  @Post("actions/:id/decide")
  async decide(
    @CurrentUser() user: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { decision?: string }
  ) {
    if (body.decision !== "approved" && body.decision !== "rejected") {
      throw new BadRequestException("decision must be 'approved' or 'rejected'");
    }
    const [action] = await this.db.select().from(proposedActions)
      .where(and(eq(proposedActions.id, id), eq(proposedActions.orgId, user.orgId)));
    if (!action) throw new NotFoundException("Proposal not found");
    if (action.status !== "pending") throw new BadRequestException(`Already ${action.status}`);
    await this.portal.resolveLocation(user, action.locationId); // tenancy check

    // The workflow owns the state machine: signal it and let its activity
    // write the final status. If the workflow is gone (expired/completed),
    // fall back to updating the row directly so the queue stays truthful.
    try {
      await this.temporal.signalApproval(action.workflowId, body.decision, user.email);
    } catch {
      await this.db.update(proposedActions)
        .set({ status: body.decision, decidedBy: user.email, decidedAt: new Date() })
        .where(eq(proposedActions.id, id));
    }
    await this.audit.log({
      orgId: user.orgId, locationId: action.locationId, actorType: "user", actor: user.email,
      action: `approval.${body.decision}`, resource: "proposed_action", resourceId: String(id),
      purpose: action.type
    });
    return { ok: true };
  }

  // --- simulated SMS gateway ---------------------------------------------------

  @Get("sms")
  async listSms(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const rows = await this.db
      .select({
        id: smsMessages.id,
        patientSourceId: smsMessages.patientSourceId,
        direction: smsMessages.direction,
        body: smsMessages.body,
        createdAt: smsMessages.createdAt,
        workflowId: smsMessages.workflowId,
        provider: smsMessages.provider,
        status: smsMessages.status,
        error: smsMessages.error,
        patientFirst: patients.firstName,
        patientLast: patients.lastName
      })
      .from(smsMessages)
      .leftJoin(patients, and(
        eq(patients.locationId, smsMessages.locationId),
        eq(patients.sourceId, smsMessages.patientSourceId)
      ))
      .where(eq(smsMessages.locationId, loc.id))
      .orderBy(smsMessages.createdAt)
      .limit(200);
    return rows;
  }

  @Post("sms/inbound")
  async inbound(
    @CurrentUser() user: SessionUser,
    @Body() body: { locationId?: number; patientSourceId?: number; body?: string }
  ) {
    if (!body.locationId || !body.patientSourceId || !body.body?.trim()) {
      throw new BadRequestException("locationId, patientSourceId, body required");
    }
    const loc = await this.portal.resolveLocation(user, body.locationId);

    // Route the reply to the workflow that most recently texted this patient.
    const [lastOutbound] = await this.db.select().from(smsMessages)
      .where(and(
        eq(smsMessages.locationId, loc.id),
        eq(smsMessages.patientSourceId, body.patientSourceId),
        eq(smsMessages.direction, "outbound")
      ))
      .orderBy(desc(smsMessages.createdAt))
      .limit(1);

    await this.db.insert(smsMessages).values({
      orgId: user.orgId,
      locationId: loc.id,
      patientSourceId: body.patientSourceId,
      direction: "inbound",
      body: body.body.trim(),
      workflowId: lastOutbound?.workflowId ?? null
    });

    // Keyword fast-path (CHANGE → reschedule) + reply threading (C3).
    const routed = await this.inboundRouter.route({
      orgId: user.orgId,
      locationId: loc.id,
      siteKey: loc.key,
      patientSourceId: body.patientSourceId,
      body: body.body,
      lastWorkflowId: lastOutbound?.workflowId ?? null
    });
    return { ok: true, routedTo: routed.routedTo, startedReschedule: routed.startedReschedule };
  }
}
