import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { locations } from "@dental/db";
import { DB, type Db } from "../db";

export interface EdgeSite {
  locationId: number;
  orgId: number;
  siteKey: string;
}

// Authenticates the Edge Synchronizer by per-site API key and resolves it to
// a tenant. Everything under /edge is scoped to exactly one location.
@Injectable()
export class EdgeAuthGuard implements CanActivate {
  constructor(@Inject(DB) private db: Db) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const key = req.headers["x-edge-api-key"];
    if (!key || typeof key !== "string") throw new UnauthorizedException("Missing edge API key");
    const [loc] = await this.db.select().from(locations).where(eq(locations.edgeApiKey, key));
    if (!loc) throw new UnauthorizedException("Unknown edge API key");
    req.edgeSite = { locationId: loc.id, orgId: loc.orgId, siteKey: loc.key } satisfies EdgeSite;
    return true;
  }
}
