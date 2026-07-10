import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import { PmsMode } from "@dental/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const site = (process.env.EDGE_SITE ?? "a").toLowerCase();
if (site !== "a" && site !== "b") throw new Error(`EDGE_SITE must be 'a' or 'b', got '${site}'`);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

// PMS integration mode (A1): api | mysql | mock, per site override supported
// (PMS_MODE_A / PMS_MODE_B win over PMS_MODE). PMS_FALLBACK=mock keeps demos
// alive when the configured adapter dies.
const rawMode = process.env[`PMS_MODE_${site.toUpperCase()}`] ?? process.env.PMS_MODE ?? "mysql";
const pmsMode = PmsMode.parse(rawMode.toLowerCase());
const rawFallback = (process.env.PMS_FALLBACK ?? "").toLowerCase();

export const config = {
  siteKey: site,
  pmsMode,
  pmsFallback: rawFallback === "mock" ? ("mock" as const) : null,
  // Only required when a mode actually needs it (mock mode runs with nothing).
  mysqlUrl: process.env[site === "a" ? "OPENDENTAL_A_URL" : "OPENDENTAL_B_URL"],
  odApiUrl: process.env.OD_API_URL,
  odApiDeveloperKey: process.env.OD_API_DEV_KEY ?? "dev-key",
  odApiCustomerKey: process.env.OD_API_CUST_KEY ?? "cust-key",
  // Webhook hint listener port (api mode): OD API Events post here; each event
  // just accelerates the next poll — polling stays the source of truth.
  webhookPort: Number(process.env.EDGE_WEBHOOK_PORT ?? 0), // 0 = disabled
  mockSeed: Number(process.env.MOCK_SEED ?? (site === "a" ? 101 : 202)),
  mockTickMs: Math.max(500, 30_000 / Number(process.env.SIM_SPEED ?? 1)),
  cloudUrl: process.env.API_URL ?? "http://localhost:4000",
  apiKey: env(site === "a" ? "EDGE_SITE_A_API_KEY" : "EDGE_SITE_B_API_KEY"),
  pollMs: Number(process.env.EDGE_POLL_MS ?? 3000),
  batchSize: 200,
  // Consecutive health failures before hot-swapping to the mock adapter.
  healthFailureLimit: Number(process.env.PMS_HEALTH_FAILURE_LIMIT ?? 3),
  // Local durable state (cursors, outbox, applied command ids) — survives restarts.
  stateFile: path.resolve(__dirname, `../../../edge-sync-state/site-${site}.json`)
};
