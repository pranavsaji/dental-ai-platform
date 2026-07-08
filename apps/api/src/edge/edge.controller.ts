import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { CommandAck, SyncBatch } from "@dental/shared";
import { EdgeAuthGuard, type EdgeSite } from "./edge-auth.guard";
import { IngestService } from "./ingest.service";
import { CommandsService } from "./commands.service";

@Controller("edge")
@UseGuards(EdgeAuthGuard)
export class EdgeController {
  constructor(
    private ingest: IngestService,
    private commands: CommandsService
  ) {}

  @Post("sync")
  async sync(@Req() req: any, @Body() body: unknown) {
    const site: EdgeSite = req.edgeSite;
    const batch = SyncBatch.parse(body);
    return this.ingest.ingestBatch(site, batch);
  }

  @Get("commands")
  async pendingCommands(@Req() req: any) {
    return this.commands.pendingFor(req.edgeSite as EdgeSite);
  }

  @Post("commands/ack")
  async ackCommand(@Req() req: any, @Body() body: unknown) {
    const ack = CommandAck.parse(body);
    await this.commands.ack(req.edgeSite as EdgeSite, ack);
    return { ok: true };
  }
}
