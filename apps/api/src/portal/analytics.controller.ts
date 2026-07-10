import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtGuard, CurrentUser, type SessionUser } from "../auth/auth";
import { AuditService } from "../audit.service";
import { AnalyticsService } from "./analytics.service";

// Cross-location analytics reads (D2). The service enforces the org-wide
// gate (admin/provider, not location-pinned) — the first read surface that
// scopes by orgId alone. Reads only the D1 rollup rows, never PMS mirrors.
@Controller("portal/analytics")
@UseGuards(JwtGuard)
export class AnalyticsController {
  constructor(
    private analytics: AnalyticsService,
    private audit: AuditService
  ) {}

  @Get("summary")
  async summary(@CurrentUser() user: SessionUser, @Query("days") days?: string) {
    const res = await this.analytics.summary(user, days ? Number(days) : 30);
    await this.audit.log({
      orgId: user.orgId, locationId: null, actorType: "user",
      actor: user.email, action: "analytics.viewed", resource: "daily_location_metrics",
      resourceId: `${res.from}..${res.to}`, purpose: "cross-location comparison"
    });
    return res;
  }

  @Get("trends")
  async trends(@CurrentUser() user: SessionUser, @Query("days") days?: string) {
    return this.analytics.trends(user, days ? Number(days) : 30);
  }
}
