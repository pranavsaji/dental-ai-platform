import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const site = (process.env.EDGE_SITE ?? "a").toLowerCase();
if (site !== "a" && site !== "b") throw new Error(`EDGE_SITE must be 'a' or 'b', got '${site}'`);

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  siteKey: site,
  mysqlUrl: env(site === "a" ? "OPENDENTAL_A_URL" : "OPENDENTAL_B_URL"),
  cloudUrl: process.env.API_URL ?? "http://localhost:4000",
  apiKey: env(site === "a" ? "EDGE_SITE_A_API_KEY" : "EDGE_SITE_B_API_KEY"),
  pollMs: Number(process.env.EDGE_POLL_MS ?? 3000),
  batchSize: 200,
  // Local durable state (cursors, outbox, applied command ids) — survives restarts.
  stateFile: path.resolve(__dirname, `../../../edge-sync-state/site-${site}.json`)
};
