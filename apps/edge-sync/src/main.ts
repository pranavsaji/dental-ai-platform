// Dental AI Platform Edge Synchronizer — runs "on-prem" beside OpenDental.
//
// Three loops on one interval, all speaking to the PMS through a pluggable
// adapter (PMS_MODE = api | mysql | mock):
//   1. capture  — pull each table's changes past the saved cursor via the
//                 adapter, append canonical events to the outbox
//   2. drain    — push outbox batches to the cloud; only advance on ack
//   3. commands — pull pending cloud commands, apply via the adapter, ack
//
// Delivery is at-least-once; eventIds are deterministic so the cloud dedupes.
// If the configured adapter fails health checks repeatedly and
// PMS_FALLBACK=mock is set, the edge hot-swaps to the embedded practice
// simulator so demos never die — and reports the degradation honestly via
// /edge/heartbeat.

import http from "node:http";
import { SyncTable, type SyncEvent } from "@dental/shared";
import { config } from "./config.js";
import { StateStore } from "./state.js";
import { SYNC_ORDER } from "./transform.js";
import { pushBatch, fetchCommands, ackCommand, postHeartbeat } from "./cloud.js";
import { createAdapter, type PmsAdapter } from "./adapters/index.js";

const log = (msg: string) => console.log(`[edge:${config.siteKey}] ${msg}`);

const state = new StateStore(config.stateFile);

const adapterConfig = {
  mysqlUrl: config.mysqlUrl,
  odApiUrl: config.odApiUrl,
  odApiDeveloperKey: config.odApiDeveloperKey,
  odApiCustomerKey: config.odApiCustomerKey,
  mockSeed: config.mockSeed,
  mockTickMs: config.mockTickMs,
  onMockEvent: (desc: string) => log(`sim: ${desc}`)
};

let adapter: PmsAdapter;
let degradedDetail = ""; // non-empty once fallback engaged
try {
  adapter = createAdapter(config.pmsMode, adapterConfig);
} catch (err) {
  if (config.pmsFallback === "mock" && config.pmsMode !== "mock") {
    degradedDetail = `adapter construction failed: ${(err as Error).message}`;
    log(`!!! ${degradedDetail} — falling back to mock adapter`);
    adapter = createAdapter("mock", adapterConfig);
  } else {
    throw err;
  }
}

let healthFailures = 0;
async function checkHealthAndMaybeFallback(): Promise<void> {
  const h = await adapter.health().catch((err) => ({ ok: false, detail: (err as Error).message }));
  if (h.ok) {
    healthFailures = 0;
    return;
  }
  healthFailures++;
  log(`adapter health check failed (${healthFailures}/${config.healthFailureLimit}): ${h.detail}`);
  if (
    healthFailures >= config.healthFailureLimit &&
    config.pmsFallback === "mock" &&
    adapter.mode !== "mock"
  ) {
    degradedDetail = `${adapter.mode} adapter unhealthy: ${h.detail}`;
    log(`!!! ${degradedDetail} — hot-swapping to mock adapter so workflows keep running`);
    await adapter.close().catch(() => {});
    adapter = createAdapter("mock", adapterConfig);
    healthFailures = 0;
  }
}

// Cursor state is namespaced per adapter so a later recovery doesn't corrupt
// the original adapter's cursors. The mysql namespace keeps the legacy
// un-prefixed keys for backward compatibility with existing state files.
function cursorKey(table: SyncTable): string {
  return adapter.mode === "mysql" ? table : `${adapter.mode}:${table}`;
}

async function captureAll(): Promise<void> {
  let total = 0;
  for (const table of SYNC_ORDER) {
    const key = cursorKey(table);
    const { rows, next } = await adapter.capture(table, state.cursor(key), config.batchSize);
    if (rows.length === 0) continue;
    const events: SyncEvent[] = rows.map((r) => ({
      eventId: `${config.siteKey}:${table}:${r.sourceId}:${r.stamp}`,
      table,
      sourceId: r.sourceId,
      stamp: r.stamp.replace(" ", "T"),
      payload: r.payload
    }));
    state.enqueue(events);
    if (next) state.setCursor(key, next);
    total += events.length;
  }
  if (total > 0) {
    state.save();
    log(`captured ${total} changed rows via ${adapter.mode} -> outbox (${state.get().outbox.length} pending)`);
  }
}

let backoffMs = 0;
async function drainOutbox(): Promise<void> {
  if (backoffMs > 0) {
    backoffMs = Math.max(0, backoffMs - config.pollMs);
    return;
  }
  while (state.get().outbox.length > 0) {
    const batch = state.get().outbox.slice(0, config.batchSize);
    try {
      const ack = await pushBatch({
        siteKey: config.siteKey,
        sentAt: new Date().toISOString(),
        events: batch
      });
      state.dequeue(batch.length);
      state.save();
      log(`pushed ${batch.length} events (accepted ${ack.accepted}, dup ${ack.duplicates})`);
    } catch (err) {
      backoffMs = Math.min(60_000, backoffMs === 0 ? 5_000 : backoffMs * 2);
      log(`cloud push failed (${(err as Error).message}); retrying in ${backoffMs / 1000}s`);
      return;
    }
  }
}

async function processCommands(): Promise<void> {
  let commands;
  try {
    commands = await fetchCommands();
  } catch {
    return; // cloud unreachable; capture keeps running
  }
  for (const cmd of commands) {
    if (state.wasCommandApplied(cmd.commandId)) {
      await ackCommand({ commandId: cmd.commandId, status: "applied", resultSourceId: null, error: null })
        .catch(() => {});
      continue;
    }
    try {
      const { sourceId } = await adapter.apply(cmd.payload);
      state.markCommandApplied(cmd.commandId);
      state.save();
      await ackCommand({ commandId: cmd.commandId, status: "applied", resultSourceId: sourceId, error: null });
      log(`applied command ${cmd.payload.type} (${cmd.commandId}) via ${adapter.mode} -> source id ${sourceId}`);
    } catch (err) {
      await ackCommand({
        commandId: cmd.commandId, status: "failed",
        resultSourceId: null, error: (err as Error).message
      }).catch(() => {});
      log(`command ${cmd.commandId} failed: ${(err as Error).message}`);
    }
  }
}

async function sendHeartbeat(): Promise<void> {
  await postHeartbeat({
    configuredMode: config.pmsMode,
    activeMode: adapter.mode,
    status: degradedDetail ? "degraded" : "live",
    detail: degradedDetail,
    at: new Date().toISOString()
  }).catch(() => {}); // heartbeat is best-effort; next tick retries
}

let running = false;
let pokeRequested = false;
async function tick(): Promise<void> {
  if (running) {
    pokeRequested = true; // webhook hint arrived mid-tick; run again right after
    return;
  }
  running = true;
  try {
    await checkHealthAndMaybeFallback();
    await captureAll();
    await drainOutbox();
    await processCommands();
    await sendHeartbeat();
  } catch (err) {
    healthFailures++;
    log(`tick error: ${(err as Error).message}`);
  } finally {
    running = false;
    if (pokeRequested) {
      pokeRequested = false;
      setImmediate(() => void tick());
    }
  }
}

// OD API Events (api mode): a tiny listener that treats every webhook as a
// hint to poll immediately. The event payload is never trusted — capture()
// against the API remains the source of truth.
if (config.pmsMode === "api" && config.webhookPort > 0) {
  http.createServer((req, res) => {
    if (req.method === "POST") {
      req.resume(); // drain body; contents intentionally ignored
      req.on("end", () => {
        res.writeHead(204).end();
        log("webhook hint received -> capturing now");
        void tick();
      });
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    }
  }).listen(config.webhookPort, () => log(`webhook hint listener on :${config.webhookPort}`));
}

log(`starting in PMS_MODE=${config.pmsMode} (active: ${adapter.mode}) -> ${config.cloudUrl} (poll ${config.pollMs}ms)` +
  (config.pmsFallback ? " [fallback: mock]" : ""));
await tick();
setInterval(tick, config.pollMs);
