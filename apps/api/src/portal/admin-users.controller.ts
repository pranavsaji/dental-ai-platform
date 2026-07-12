// F3: admin user management. Users stop being seed-only: admins invite (temp
// password shown once), disable (same-day termination — the access-control
// policy's button; JwtGuard rejects disabled users within its 30s cache),
// re-enable, change role/location pinning, reset passwords and MFA, and see
// linked SSO identities. Every mutation is audited with actor + target.

import {
  BadRequestException, Body, Controller, Get, Inject,
  NotFoundException, Param, ParseIntPipe, Patch, Post, UseGuards
} from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { authIdentities, locations, scryptHash, users } from "@dental/db";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import { CurrentUser, JwtGuard, invalidateDisabledCache, type SessionUser } from "../auth/auth";
import { assertRole } from "../auth/roles";

const ROLES = new Set(["admin", "provider", "staff"]);

function tempPassword(): string {
  // 16 hex chars — enough entropy for a first login the user must change...
  // (password rotation itself is out of scope; the reset button re-issues).
  return randomBytes(8).toString("hex");
}

@Controller("portal/admin/users")
@UseGuards(JwtGuard)
export class AdminUsersController {
  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  private assertAdmin(user: SessionUser): void {
    assertRole(user, "admin"); // G4: shared gate — one grep-able policy helper
  }

  private async mustGet(orgId: number, id: number) {
    const [row] = await this.db.select().from(users)
      .where(and(eq(users.id, id), eq(users.orgId, orgId)));
    if (!row) throw new NotFoundException("User not found");
    return row;
  }

  @Get()
  async list(@CurrentUser() me: SessionUser) {
    this.assertAdmin(me);
    const rows = await this.db.select().from(users).where(eq(users.orgId, me.orgId));
    const identities = await this.db.select().from(authIdentities);
    const locs = await this.db.select({ id: locations.id, name: locations.name })
      .from(locations).where(eq(locations.orgId, me.orgId));
    return {
      locations: locs,
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        locationId: u.locationId,
        disabledAt: u.disabledAt,
        mfaEnrolled: Boolean(u.mfaEnrolledAt),
        hasPassword: Boolean(u.passwordHash),
        createdAt: u.createdAt,
        identities: identities
          .filter((i) => i.userId === u.id)
          .map((i) => ({ issuer: i.issuer, email: i.email, lastLoginAt: i.lastLoginAt }))
      }))
    };
  }

  /** Invite: creates the account with a temp password (returned exactly once). */
  @Post()
  async invite(
    @CurrentUser() me: SessionUser,
    @Body() body: { email?: string; name?: string; role?: string; locationId?: number | null }
  ) {
    this.assertAdmin(me);
    const email = (body.email ?? "").toLowerCase().trim();
    const name = (body.name ?? "").trim();
    if (!email.includes("@") || !name) throw new BadRequestException("email and name required");
    if (!ROLES.has(body.role ?? "")) throw new BadRequestException("role must be admin|provider|staff");
    const [existing] = await this.db.select().from(users).where(eq(users.email, email));
    if (existing) throw new BadRequestException("A user with that email already exists");
    if (body.locationId != null) {
      const [loc] = await this.db.select().from(locations)
        .where(and(eq(locations.id, body.locationId), eq(locations.orgId, me.orgId)));
      if (!loc) throw new BadRequestException("Unknown location");
    }
    const password = tempPassword();
    const [row] = await this.db.insert(users).values({
      orgId: me.orgId,
      email,
      name,
      role: body.role!,
      locationId: body.locationId ?? null,
      passwordHash: scryptHash(password)
    }).returning();
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.invited", resource: "user", resourceId: String(row.id),
      purpose: `${email} as ${body.role}${body.locationId ? ` @ location ${body.locationId}` : " (org-wide)"}`
    });
    return { id: row.id, email, tempPassword: password };
  }

  /** Role / location pinning / display-name changes. */
  @Patch(":id")
  async update(
    @CurrentUser() me: SessionUser,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { name?: string; role?: string; locationId?: number | null }
  ) {
    this.assertAdmin(me);
    const target = await this.mustGet(me.orgId, id);
    const changes: string[] = [];
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.name && body.name.trim() && body.name !== target.name) {
      set.name = body.name.trim();
      changes.push(`name → ${set.name}`);
    }
    if (body.role && body.role !== target.role) {
      if (!ROLES.has(body.role)) throw new BadRequestException("role must be admin|provider|staff");
      if (target.id === me.sub) throw new BadRequestException("You cannot change your own role");
      set.role = body.role;
      changes.push(`role ${target.role} → ${body.role}`);
    }
    if (body.locationId !== undefined && body.locationId !== target.locationId) {
      if (body.locationId != null) {
        const [loc] = await this.db.select().from(locations)
          .where(and(eq(locations.id, body.locationId), eq(locations.orgId, me.orgId)));
        if (!loc) throw new BadRequestException("Unknown location");
      }
      set.locationId = body.locationId;
      changes.push(`location ${target.locationId ?? "org-wide"} → ${body.locationId ?? "org-wide"}`);
    }
    if (changes.length === 0) return { ok: true, changed: [] };
    await this.db.update(users).set(set).where(eq(users.id, target.id));
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.updated", resource: "user", resourceId: String(id),
      purpose: `${target.email}: ${changes.join("; ")}`
    });
    return { ok: true, changed: changes };
  }

  /** Same-day termination: takes effect within the guard's 30s cache window. */
  @Post(":id/disable")
  async disable(@CurrentUser() me: SessionUser, @Param("id", ParseIntPipe) id: number) {
    this.assertAdmin(me);
    const target = await this.mustGet(me.orgId, id);
    if (target.id === me.sub) throw new BadRequestException("You cannot disable your own account");
    if (target.disabledAt) throw new BadRequestException("Already disabled");
    await this.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, id));
    invalidateDisabledCache(id);
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.disabled", resource: "user", resourceId: String(id),
      purpose: target.email
    });
    return { ok: true };
  }

  @Post(":id/enable")
  async enable(@CurrentUser() me: SessionUser, @Param("id", ParseIntPipe) id: number) {
    this.assertAdmin(me);
    const target = await this.mustGet(me.orgId, id);
    if (!target.disabledAt) throw new BadRequestException("Not disabled");
    await this.db.update(users).set({ disabledAt: null }).where(eq(users.id, id));
    invalidateDisabledCache(id);
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.enabled", resource: "user", resourceId: String(id),
      purpose: target.email
    });
    return { ok: true };
  }

  /** New temp password (shown once); clears nothing else. */
  @Post(":id/reset-password")
  async resetPassword(@CurrentUser() me: SessionUser, @Param("id", ParseIntPipe) id: number) {
    this.assertAdmin(me);
    const target = await this.mustGet(me.orgId, id);
    const password = tempPassword();
    await this.db.update(users).set({ passwordHash: scryptHash(password) }).where(eq(users.id, id));
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.password_reset", resource: "user", resourceId: String(id),
      purpose: target.email
    });
    return { ok: true, tempPassword: password };
  }

  /** Lost authenticator: wipes enrollment so the user re-enrolls at next login. */
  @Post(":id/reset-mfa")
  async resetMfa(@CurrentUser() me: SessionUser, @Param("id", ParseIntPipe) id: number) {
    this.assertAdmin(me);
    const target = await this.mustGet(me.orgId, id);
    if (!target.mfaEnrolledAt) throw new BadRequestException("MFA not enrolled");
    await this.db.update(users)
      .set({ mfaSecret: null, mfaEnrolledAt: null, mfaRecoveryCodes: [] })
      .where(eq(users.id, id));
    await this.audit.log({
      orgId: me.orgId, actorType: "user", actor: me.email,
      action: "user.mfa_reset", resource: "user", resourceId: String(id),
      purpose: target.email
    });
    return { ok: true };
  }
}
