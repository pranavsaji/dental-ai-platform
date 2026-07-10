import {
  BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards
} from "@nestjs/common";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { PortalService } from "./portal.service";
import { TasksService } from "./tasks.service";

@Controller("portal/tasks")
@UseGuards(JwtGuard)
export class TasksController {
  constructor(
    private portal: PortalService,
    private tasksService: TasksService
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
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    await this.tasksService.claim(user.orgId, loc.id, id, user.sub, user.email);
    return { ok: true };
  }

  @Post(":id/resolve")
  async resolve(
    @CurrentUser() user: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { outcome?: "done" | "dismissed" },
    @Query("locationId") locationId?: string
  ) {
    const outcome = body.outcome ?? "done";
    if (outcome !== "done" && outcome !== "dismissed") {
      throw new BadRequestException("outcome must be done or dismissed");
    }
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    await this.tasksService.resolve(user.orgId, loc.id, id, user.email, outcome);
    return { ok: true };
  }
}
