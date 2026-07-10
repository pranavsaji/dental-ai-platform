import { z } from "zod";

// ---------------------------------------------------------------------------
// Edge heartbeat (A1): the synchronizer posts this every tick so the cloud
// can show honest provenance — "site A: live via mysql / site B: mock" —
// and can surface a degraded adapter the moment fallback kicks in.
// ---------------------------------------------------------------------------

export const PmsMode = z.enum(["api", "mysql", "mock"]);
export type PmsMode = z.infer<typeof PmsMode>;

export const EdgeHeartbeat = z.object({
  // Mode the edge is configured for vs the adapter actually serving traffic —
  // they differ exactly when fallback has engaged.
  configuredMode: PmsMode,
  activeMode: PmsMode,
  status: z.enum(["live", "degraded"]),
  detail: z.string().max(500).default(""),
  at: z.string() // ISO timestamp on the edge
});
export type EdgeHeartbeat = z.infer<typeof EdgeHeartbeat>;
