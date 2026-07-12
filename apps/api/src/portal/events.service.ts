// F1: platform event fan-out. Services publish typed events at the moments a
// human would want a nudge (approval.created, task.created, sms.received,
// sync.lagging, huddle.ready); publish() persists a notifications row (the
// bell's backlog on page load) and pushes the event to every live SSE
// subscriber. In-process emitter — same single-instance trade-off as the
// in-process Temporal worker and quiet-hours outbox.

import { EventEmitter } from "node:events";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Observable, filter, fromEvent, interval, map, merge } from "rxjs";
import { and, desc, eq } from "drizzle-orm";
import { notifications } from "@dental/db";
import { DB, type Db } from "../db";

export type PlatformEventType =
  | "approval.created" | "task.created" | "sms.received" | "sync.lagging" | "huddle.ready";

export interface PlatformEvent {
  orgId: number;
  locationId: number;
  type: PlatformEventType;
  title: string;
  body?: string;
  resourceType?: string | null;
  resourceId?: string | null;
}

export interface SseMessage {
  /** Named SSE event; the shell listens per type and to "notification". */
  type: string;
  data: string;
}

@Injectable()
export class EventsService {
  private readonly log = new Logger("Events");
  private readonly emitter = new EventEmitter();

  constructor(@Inject(DB) private db: Db) {
    this.emitter.setMaxListeners(200); // one listener per open dashboard tab
  }

  /** Persist + fan out. Never throws into the caller's workflow path. */
  async publish(evt: PlatformEvent): Promise<void> {
    try {
      const [row] = await this.db.insert(notifications).values({
        orgId: evt.orgId,
        locationId: evt.locationId,
        type: evt.type,
        title: evt.title,
        body: evt.body ?? "",
        resourceType: evt.resourceType ?? null,
        resourceId: evt.resourceId ?? null
      }).returning();
      this.emitter.emit("event", { ...evt, id: row.id, createdAt: row.createdAt });
    } catch (e) {
      this.log.warn(`event publish failed (${evt.type}): ${(e as Error).message}`);
    }
  }

  /**
   * Live stream for one org/location, with a 25s keepalive comment so proxies
   * don't reap idle connections. Every event goes out under the generic
   * "notification" name; the payload carries its specific type.
   */
  stream(orgId: number, locationId: number | null): Observable<SseMessage> {
    const events = fromEvent(this.emitter, "event").pipe(
      map((e) => e as PlatformEvent & { id: number; createdAt: Date }),
      filter((e) => e.orgId === orgId && (locationId == null || e.locationId === locationId)),
      map((e) => ({ type: "notification", data: JSON.stringify(e) }))
    );
    const keepalive = interval(25_000).pipe(
      map(() => ({ type: "ping", data: "{}" }))
    );
    return merge(events, keepalive);
  }

  /** Bell backlog: the most recent notifications for a location. */
  async recent(orgId: number, locationId: number, limit = 50) {
    return this.db.select().from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.locationId, locationId)))
      .orderBy(desc(notifications.createdAt))
      .limit(Math.min(limit, 100));
  }
}
