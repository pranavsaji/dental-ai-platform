import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from "@nestjs/common";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { assertCan } from "../auth/roles";
import { PortalService } from "./portal.service";
import { AuditService } from "../audit.service";

@Controller("portal")
@UseGuards(JwtGuard)
export class PortalController {
  constructor(
    private portal: PortalService,
    private audit: AuditService
  ) {}

  @Get("me")
  me(@CurrentUser() user: SessionUser) {
    return user;
  }

  @Get("locations")
  locations(@CurrentUser() user: SessionUser) {
    return this.portal.listLocations(user);
  }

  @Get("overview")
  overview(@CurrentUser() user: SessionUser, @Query("locationId") locationId?: string) {
    return this.portal.overview(user, locationId ? Number(locationId) : undefined);
  }

  @Get("schedule")
  async schedule(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("date") date?: string
  ) {
    assertCan(user, "schedule.read"); // provider rows are scoped in the service
    const result = await this.portal.schedule(user, locationId ? Number(locationId) : undefined, date);
    await this.audit.log({
      orgId: user.orgId, locationId: result.location.id, actorType: "user", actor: user.email,
      action: "phi.read.schedule", resource: "schedule", resourceId: result.date, purpose: "operations"
    });
    return result;
  }

  @Get("patients")
  async patients(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("q") q = ""
  ) {
    assertCan(user, "patients.read"); // provider rows are scoped in the service
    const rows = await this.portal.searchPatients(user, locationId ? Number(locationId) : undefined, q);
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: "phi.read.patient_search", resource: "patient", resourceId: q, purpose: "operations"
    });
    return rows;
  }

  @Get("patients/:locationId/:sourceId")
  async patient(
    @CurrentUser() user: SessionUser,
    @Param("locationId", ParseIntPipe) locationId: number,
    @Param("sourceId", ParseIntPipe) sourceId: number
  ) {
    assertCan(user, "patients.read"); // + assertPatientAccess in the service
    const result = await this.portal.patientTimeline(user, locationId, sourceId);
    await this.audit.log({
      orgId: user.orgId, locationId, actorType: "user", actor: user.email,
      action: "phi.read.patient_chart", resource: "patient", resourceId: String(sourceId), purpose: "care"
    });
    return result;
  }

  @Get("audit")
  auditList(@CurrentUser() user: SessionUser, @Query("limit") limit?: string) {
    return this.portal.auditEntries(user, limit ? Number(limit) : 100);
  }

  // F2: tamper-evidence check — recomputes the audit hash chain. Same role
  // gate as reading the audit log itself; the check is itself audited so the
  // chain records who verified it and what anchor they saw.
  @Get("audit/verify")
  async auditVerify(@CurrentUser() user: SessionUser, @Query("limit") limit?: string) {
    assertCan(user, "audit.read");
    const result = await this.audit.verifyChain(limit ? Number(limit) : undefined);
    await this.audit.log({
      orgId: user.orgId, actorType: "user", actor: user.email,
      action: result.ok ? "audit.chain.verified" : "audit.chain.broken",
      resource: "audit_log",
      resourceId: result.anchor ? String(result.anchor.id) : "",
      purpose: `${result.detail}${result.anchor ? `; anchor ${result.anchor.entryHash.slice(0, 16)}…` : ""}`
    });
    return result;
  }
}
