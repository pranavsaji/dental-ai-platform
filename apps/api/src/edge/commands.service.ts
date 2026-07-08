import { Inject, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { edgeCommands, locations } from "@dental/db";
import type { CommandAck, CommandPayload, EdgeCommand } from "@dental/shared";
import { DB, type Db } from "../db";
import { AuditService } from "../audit.service";
import type { EdgeSite } from "./edge-auth.guard";

// Durable command queue: the only mutation path back into the PMS. Commands
// stay servable until the edge acks them (the edge dedupes re-deliveries), so
// a crash on either side never drops a booking.
@Injectable()
export class CommandsService {
  private readonly log = new Logger("Commands");

  constructor(
    @Inject(DB) private db: Db,
    private audit: AuditService
  ) {}

  async issue(
    orgId: number,
    locationId: number,
    payload: CommandPayload,
    actor: string
  ): Promise<string> {
    const commandId = randomUUID();
    await this.db.insert(edgeCommands).values({
      commandId,
      orgId,
      locationId,
      type: payload.type,
      payload
    });
    await this.audit.log({
      orgId, locationId, actorType: "agent", actor,
      action: `command.issued.${payload.type}`, resource: "edge_command", resourceId: commandId
    });
    this.log.log(`issued ${payload.type} (${commandId}) for location ${locationId}`);
    return commandId;
  }

  async pendingFor(site: EdgeSite): Promise<EdgeCommand[]> {
    const rows = await this.db
      .select()
      .from(edgeCommands)
      .where(and(
        eq(edgeCommands.locationId, site.locationId),
        inArray(edgeCommands.status, ["pending", "delivered"])
      ))
      .orderBy(asc(edgeCommands.createdAt))
      .limit(20);
    if (rows.length > 0) {
      await this.db.update(edgeCommands)
        .set({ status: "delivered", updatedAt: new Date() })
        .where(inArray(edgeCommands.commandId, rows.map((r) => r.commandId)));
    }
    return rows.map((r) => ({
      commandId: r.commandId,
      siteKey: site.siteKey,
      issuedAt: r.createdAt.toISOString(),
      payload: r.payload as CommandPayload
    }));
  }

  async ack(site: EdgeSite, ack: CommandAck): Promise<void> {
    await this.db.update(edgeCommands)
      .set({
        status: ack.status,
        resultSourceId: ack.resultSourceId,
        error: ack.error,
        updatedAt: new Date()
      })
      .where(and(
        eq(edgeCommands.commandId, ack.commandId),
        eq(edgeCommands.locationId, site.locationId)
      ));
    await this.audit.log({
      orgId: site.orgId, locationId: site.locationId, actorType: "edge",
      actor: `edge:${site.siteKey}`,
      action: `command.${ack.status}`, resource: "edge_command", resourceId: ack.commandId,
      purpose: ack.error ?? ""
    });
  }

  async getStatus(commandId: string) {
    const [row] = await this.db.select().from(edgeCommands).where(eq(edgeCommands.commandId, commandId));
    return row ?? null;
  }

  async locationByKey(siteKey: string) {
    const [loc] = await this.db.select().from(locations).where(eq(locations.key, siteKey));
    return loc ?? null;
  }
}
