// Practice simulator CLI (DB mode — mutates the simulated OpenDental MySQL).
//
// Usage:
//   pnpm --filter @dental/simulator simulate live          # ongoing activity, 30s tick
//   pnpm --filter @dental/simulator simulate flagship-loop # named scenario
//   flags: --site a|b (default a)  --speed N (tick divisor, default SIM_SPEED or 1)
//          --seed N (rng seed, default 1)
//
// In-memory mode is not exposed here — it is what the edge MockAdapter embeds.

import path from "node:path";
import { fileURLToPath } from "node:url";
import * as dotenv from "dotenv";
import mysql from "mysql2/promise";
import { createRng } from "./rng.js";
import { MySqlOps } from "./ops.js";
import { runTick } from "./generators.js";
import { SCENARIOS } from "./scenarios.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = process.argv[2];
if (!target || target.startsWith("--")) {
  console.log("Usage: simulate <live|" + Object.keys(SCENARIOS).join("|") + "> [--site a|b] [--speed N] [--seed N]");
  process.exit(1);
}

const site = (flag("site") ?? "a").toLowerCase();
const url = process.env[site === "a" ? "OPENDENTAL_A_URL" : "OPENDENTAL_B_URL"];
if (!url) throw new Error(`Missing OPENDENTAL_${site.toUpperCase()}_URL in .env`);
const speed = Number(flag("speed") ?? process.env.SIM_SPEED ?? 1);
const seed = Number(flag("seed") ?? 1);

const u = new URL(url);
const pool = mysql.createPool({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1),
  dateStrings: true,
  connectionLimit: 2
});

const ops = new MySqlOps(pool);
const rng = createRng(seed);
const log = (msg: string) => console.log(`[sim:${site}] ${msg}`);

if (target === "live") {
  const tickMs = Math.max(500, 30_000 / speed);
  log(`live mode: one event every ${Math.round(tickMs / 1000)}s (speed x${speed}, seed ${seed})`);
  const tick = async () => {
    try {
      const result = await runTick(rng, ops);
      log(result ?? "tick: no candidate for chosen event");
    } catch (err) {
      log(`tick error: ${(err as Error).message}`);
    }
  };
  await tick();
  setInterval(tick, tickMs);
} else {
  const scenario = SCENARIOS[target];
  if (!scenario) {
    console.error(`Unknown scenario '${target}'. Available: live, ${Object.keys(SCENARIOS).join(", ")}`);
    process.exit(1);
  }
  log(`running scenario '${scenario.name}' — ${scenario.description}`);
  const events = await scenario.run(rng, ops);
  for (const e of events) log(e);
  log(`scenario complete (${events.length} events)`);
  await pool.end();
}
