import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { ALL_ROLES, assertRole } from "../auth/roles";
import { PortalService } from "./portal.service";
import { TasksService } from "./tasks.service";
import { TemporalService } from "../temporal/temporal.service";
import { SmsService } from "../sms/sms.service";

@Controller("portal/tasks")
@UseGuards(JwtGuard)
export class TasksController {
  constructor(
    private portal: PortalService,
    private tasksService: TasksService,
    private temporal: TemporalService,
    private sms: SmsService
  ) {}

  @Get()
  async list(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("type") type?: string
  ) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.tasksService.list(user.orgId, loc.id, { status, type });
  }

  @Get("summary")
  async summary(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.tasksService.summary(user.orgId, loc.id);
  }

  @Post()
  async create(
    @CurrentUser() user: SessionUser,
    @Body() body: {
      locationId?: number; type?: string; title?: string; body?: string;
      priority?: "low" | "normal" | "high" | "urgent"; assigneeRole?: string;
      resourceType?: string; resourceId?: string;
    }
  ) {
    assertRole(user, ...ALL_ROLES); // G4: task queue is a shared surface
    if (!body.title?.trim()) throw new BadRequestException("title required");
    const loc = await this.portal.resolveLocation(user, body.locationId);
    const id = await this.tasksService.create({
      orgId: user.orgId,
      locationId: loc.id,
      type: body.type?.trim() || "manual",
      title: body.title.trim(),
      body: body.body ?? "",
      priority: body.priority,
      assigneeRole: body.assigneeRole ?? null,
      createdBy: user.email,
      resourceType: body.resourceType ?? null,
      resourceId: body.resourceId ?? null
    });
    return { id };
  }

  @Post(":id/claim")
  async claim(
    @CurrentUser() user: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Query("locationId") locationId?: string
  ) {
    assertRole(user, ...ALL_ROLES); // G4: task queue is a shared surface
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    await this.tasksService.claim(user.orgId, loc.id, id, user.sub, user.email);
    return { ok: true };
  }

  // E2: send the (staff-reviewed, possibly edited) reply to a patient_question
  // task and resolve it. This is THE human gate the intent router promises —
  // the agent's draft never reaches the patient without passing through here.
  @Post(":id/reply")
  async reply(
    @CurrentUser() user: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { body?: string },
    @Query("locationId") locationId?: string
  ) {
    assertRole(user, ...ALL_ROLES); // G4: patient-facing send — front desk's job
    const text = body.body?.trim();
    if (!text) throw new BadRequestException("reply body required");
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const task = await this.tasksService.get(user.orgId, loc.id, id);
    if (task.type !== "patient_question") throw new BadRequestException("Only patient_question tasks accept replies");
    if (task.status !== "open" && task.status !== "in_progress") {
      throw new BadRequestException(`Task already ${task.status}`);
    }
    if (task.resourceType !== "patient" || !task.resourceId) {
      throw new BadRequestException("Task has no patient to reply to");
    }
    const result = await this.sms.send({
      orgId: user.orgId,
      locationId: loc.id,
      patientSourceId: Number(task.resourceId),
      body: text,
      workflowId: null,
      actor: user.email,
      purpose: `staff reply to patient question (task ${id})`,
      kind: "conversation"
    });
    if (result.outcome === "blocked") {
      // Don't silently resolve — the human should see why nothing went out.
      throw new BadRequestException(`Reply blocked by messaging policy: ${result.reason}`);
    }
    await this.tasksService.resolve(user.orgId, loc.id, id, user.email, "done");
    return { ok: true, outcome: result.outcome };
  }

  @Post(":id/resolve")
  async resolve(
    @CurrentUser() user: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { outcome?: "done" | "dismissed" },
    @Query("locationId") locationId?: string
  ) {
    assertRole(user, ...ALL_ROLES); // G4: task queue is a shared surface
    const outcome = body.outcome ?? "done";
    if (outcome !== "done" && outcome !== "dismissed") {
      throw new BadRequestException("outcome must be done or dismissed");
    }
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    const task = await this.tasksService.resolve(user.orgId, loc.id, id, user.email, outcome);
    // B3: a workflow parked on this task (e.g. pre-auth waiting on requested
    // documentation) resumes when the work is done. Best-effort — the
    // workflow may have completed or timed out, and dismissal doesn't resume.
    if (outcome === "done" && task.workflowId) {
      try {
        await this.temporal.signalTaskResolved(task.workflowId, task.id);
      } catch {
        // workflow gone or Temporal down; the task state is still truthful
      }
    }
    return { ok: true };
  }
}
