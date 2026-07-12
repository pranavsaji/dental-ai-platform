// F1: SSE endpoint + notification backlog. EventSource cannot set an
// Authorization header — cookie sessions (F2) are what make this guardable;
// the browser attaches the httpOnly session cookie automatically
// (withCredentials). GET-only, so no CSRF concern.

import { Controller, Get, Query, Sse, UseGuards } from "@nestjs/common";
import type { Observable } from "rxjs";
import { CurrentUser, JwtGuard, type SessionUser } from "../auth/auth";
import { EventsService, type SseMessage } from "./events.service";
import { PortalService } from "./portal.service";

@Controller("portal")
@UseGuards(JwtGuard)
export class EventsController {
  constructor(
    private events: EventsService,
    private portal: PortalService
  ) {}

  @Sse("events")
  eventsStream(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string
  ): Observable<SseMessage> {
    // Tenancy without a DB round-trip: org always from the JWT; a location-
    // pinned user is forced onto their own location regardless of the query.
    const requested = locationId ? Number(locationId) : null;
    const scope = user.locationId != null ? user.locationId : requested;
    return this.events.stream(user.orgId, scope);
  }

  @Get("notifications")
  async notifications(
    @CurrentUser() user: SessionUser,
    @Query("locationId") locationId?: string,
    @Query("limit") limit?: string
  ) {
    const loc = await this.portal.resolveLocation(user, locationId ? Number(locationId) : undefined);
    return this.events.recent(user.orgId, loc.id, limit ? Number(limit) : 50);
  }
}
