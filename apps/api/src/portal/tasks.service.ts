import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { tasks } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";

// Task management substrate (A5): the durable, assignable work queue that
// workflow dead-ends escalate into. Every transition is audited; tenancy is
// enforced by the callers resolving the location first (resolveLocation).

export interface CreateTaskInput {
  orgId: number;
  locationId: number;
  type: string;
  title: string;
  body?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  assigneeRole?: string | null;
  dueAt?: Date | null;
  createdBy: string; // user email | agent:<name> | workflow name
  workflowId?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

const PRIORITY_ORDER = sql`case ${tasks.priority}
  when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`;

@Injectable()
export class TasksService {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  async create(input: CreateTaskInput): Promise<number> {
    const [row] = await this.db.insert(tasks).values({
      orgId: input.orgId,
      locationId: input.locationId,
      type: input.type,
      title: input.title,
      body: input.body ?? "",
      priority: input.priority ?? "normal",
      assigneeRole: input.assigneeRole ?? null,
      dueAt: input.dueAt ?? null,
      createdBy: input.createdBy,
      workflowId: input.workflowId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null
    }).returning({ id: tasks.id });
    await this.audit.log({
      orgId: input.orgId, locationId: input.locationId,
      actorType: input.createdBy.startsWith("agent:") ? "agent" : "user",
      actor: input.createdBy, action: "task.created", resource: "task",
      resourceId: String(row.id), purpose: input.type
    });
    return row.id;
  }

  async list(orgId: number, locationId: number, filters: { status?: string; type?: string } = {}) {
    const conditions = [eq(tasks.orgId, orgId), eq(tasks.locationId, locationId)];
    if (filters.status) conditions.push(eq(tasks.status, filters.status));
    if (filters.type) conditions.push(eq(tasks.type, filters.type));
    return this.db.select().from(tasks)
      .where(and(...conditions))
      .orderBy(PRIORITY_ORDER, desc(tasks.createdAt))
      .limit(200);
  }

  async summary(orgId: number, locationId: number) {
    const open = eq(tasks.status, "open");
    const scope = and(eq(tasks.orgId, orgId), eq(tasks.locationId, locationId));
    const [openCount] = await this.db.select({ n: count() }).from(tasks).where(and(scope, open));
    const [inProgress] = await this.db.select({ n: count() }).from(tasks)
      .where(and(scope, eq(tasks.status, "in_progress")));
    const [urgent] = await this.db.select({ n: count() }).from(tasks)
      .where(and(scope, open, eq(tasks.priority, "urgent")));
    return { open: openCount.n, inProgress: inProgress.n, urgent: urgent.n };
  }

  async claim(orgId: number, locationId: number, taskId: number, userId: number, userEmail: string) {
    const task = await this.mustGet(orgId, locationId, taskId);
    await this.db.update(tasks)
      .set({ status: "in_progress", assigneeUserId: userId })
      .where(eq(tasks.id, task.id));
    await this.audit.log({
      orgId, locationId, actorType: "user", actor: userEmail,
      action: "task.claimed", resource: "task", resourceId: String(taskId), purpose: task.type
    });
  }

  async resolve(
    orgId: number, locationId: number, taskId: number, userEmail: string,
    outcome: "done" | "dismissed"
  ) {
    const task = await this.mustGet(orgId, locationId, taskId);
    await this.db.update(tasks)
      .set({ status: outcome, resolvedAt: new Date(), resolvedBy: userEmail })
      .where(eq(tasks.id, task.id));
    await this.audit.log({
      orgId, locationId, actorType: "user", actor: userEmail,
      action: outcome === "done" ? "task.resolved" : "task.dismissed",
      resource: "task", resourceId: String(taskId), purpose: task.type
    });
    // Returned so the controller can resume a workflow parked on this task (B3).
    return task;
  }

  private async mustGet(orgId: number, locationId: number, taskId: number) {
    const [task] = await this.db.select().from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId), eq(tasks.locationId, locationId)));
    if (!task) throw new NotFoundException("Task not found");
    return task;
  }
}
