// G1: location settings. The first write path for location policy —
// autoSendReminders (the C2 gate) finally gets its button, timezone gets a
// validated select, and integration provenance stays read-only (the edge owns
// it via heartbeat). edge_api_key is never exposed or accepted here.

import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException,
  Param, ParseIntPipe, Patch, UseGuards
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { locations } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CurrentUser, JwtGuard, type SessionUser } from "../auth/auth";
import { assertRole } from "../auth/roles";

// IANA zone list from the runtime itself — no hand-maintained allowlist.
const TIMEZONES = new Set(Intl.supportedValuesOf("timeZone"));

const SETTINGS_COLUMNS = {
  id: locations.id,
  key: locations.key,
  name: locations.name,
  timezone: locations.timezone,
  autoSendReminders: locations.autoSendReminders,
  // Read-only provenance (A1): what the edge last reported.
  integrationMode: locations.integrationMode,
  integrationStatus: locations.integrationStatus,
  lastHeartbeatAt: locations.lastHeartbeatAt
};

@Controller("portal/admin/locations")
@UseGuards(JwtGuard)
export class AdminLocationsController {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  @Get()
  async list(@CurrentUser() me: SessionUser) {
    assertRole(me, "admin");
    return this.db.select(SETTINGS_COLUMNS).from(locations)
      .where(eq(locations.orgId, me.orgId))
      .orderBy(locations.id);
  }

  /** Writable: name, timezone, autoSendReminders. Audited with a field diff. */
  @Patch(":id")
  async update(
    @CurrentUser() me: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { name?: string; timezone?: string; autoSendReminders?: boolean }
  ) {
    assertRole(me, "admin");
    const [target] = await this.db.select().from(locations)
      .where(and(eq(locations.id, id), eq(locations.orgId, me.orgId)));
    if (!target) throw new NotFoundException("Location not found");

    const changes: string[] = [];
    const set: Partial<typeof locations.$inferInsert> = {};
    if (body.name !== undefined && body.name.trim() && body.name.trim() !== target.name) {
      set.name = body.name.trim();
      changes.push(`name "${target.name}" → "${set.name}"`);
    }
    if (body.timezone !== undefined && body.timezone !== target.timezone) {
      if (!TIMEZONES.has(body.timezone)) {
        throw new BadRequestException("timezone must be a valid IANA zone (e.g. America/Chicago)");
      }
      set.timezone = body.timezone;
      changes.push(`timezone ${target.timezone} → ${body.timezone}`);
    }
    if (body.autoSendReminders !== undefined && body.autoSendReminders !== target.autoSendReminders) {
      if (typeof body.autoSendReminders !== "boolean") {
        throw new BadRequestException("autoSendReminders must be a boolean");
      }
      set.autoSendReminders = body.autoSendReminders;
      changes.push(`autoSendReminders ${target.autoSendReminders} → ${body.autoSendReminders}`);
    }
    if (changes.length === 0) return { ok: true, changed: [] };

    await this.db.update(locations).set(set).where(eq(locations.id, id));
    await this.audit.log({
      orgId: me.orgId, locationId: id, actorType: "user", actor: me.email,
      action: "location.updated", resource: "location", resourceId: String(id),
      purpose: `${target.key}: ${changes.join("; ")}`
    });
    return { ok: true, changed: changes };
  }
}
