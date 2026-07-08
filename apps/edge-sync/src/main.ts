// Dental AI Platform Edge Synchronizer — runs "on-prem" beside OpenDental.
//
// Three loops on one interval:
//   1. capture  — poll each table's DateTStamp past the saved cursor,
//                 transform rows to canonical events, append to the outbox
//   2. drain    — push outbox batches to the cloud; only advance on ack
//   3. commands — pull pending cloud commands, apply to OpenDental, ack
//
// Delivery is at-least-once; eventIds are deterministic so the cloud dedupes.
// The one-second cursor overlap (TIMESTAMP resolution) is intentional.

import mysql from "mysql2/promise";
import { SyncTable, type SyncEvent } from "@dental/shared";
import { config } from "./config.js";
import { StateStore } from "./state.js";
import { SYNC_ORDER, TABLE_META, transformRow } from "./transform.js";
import { pushBatch, fetchCommands, ackCommand } from "./cloud.js";
import { applyCommand } from "./writeback.js";

const log = (msg: string) => console.log(`[edge:${config.siteKey}] ${msg}`);

const u = new URL(config.mysqlUrl);
const pool = mysql.createPool({
  host: u.hostname,
  port: Number(u.port || 3306),
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.slice(1),
  dateStrings: true, // temporal columns as strings; avoids TZ reinterpretation
  connectionLimit: 4
});

const state = new StateStore(config.stateFile);

async function captureTable(table: SyncTable): Promise<number> {
  const meta = TABLE_META[table];
  const cursor = state.cursor(table);
  // Keyset pagination on (stamp, pk): advances through bulk changes that share
  // one TIMESTAMP second instead of refetching them forever.
  const [rows] = await pool.query<any[]>(
    `SELECT * FROM ${table}
     WHERE (${meta.stampCol} > ?) OR (${meta.stampCol} = ? AND ${meta.pk} > ?)
     ORDER BY ${meta.stampCol} ASC, ${meta.pk} ASC LIMIT ?`,
    [cursor.stamp, cursor.stamp, cursor.pk, config.batchSize]
  );
  if (rows.length === 0) return 0;

  const events: SyncEvent[] = rows.map((r) => {
    const stamp: string = r[meta.stampCol];
    return {
      eventId: `${config.siteKey}:${table}:${r[meta.pk]}:${stamp}`,
      table,
      sourceId: Number(r[meta.pk]),
      stamp: stamp.replace(" ", "T"),
      payload: transformRow(table, r)
    };
  });
  state.enqueue(events);
  const last = rows[rows.length - 1];
  state.setCursor(table, { stamp: last[meta.stampCol], pk: Number(last[meta.pk]) });
  return events.length;
}

async function captureAll(): Promise<void> {
  let total = 0;
  for (const table of SYNC_ORDER) {
    total += await captureTable(table);
  }
  if (total > 0) {
    state.save();
    log(`captured ${total} changed rows -> outbox (${state.get().outbox.length} pending)`);
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
    const conn = await pool.getConnection();
    try {
      const resultId = await applyCommand(conn, cmd.payload);
      state.markCommandApplied(cmd.commandId);
      state.save();
      await ackCommand({ commandId: cmd.commandId, status: "applied", resultSourceId: resultId, error: null });
      log(`applied command ${cmd.payload.type} (${cmd.commandId}) -> source id ${resultId}`);
    } catch (err) {
      await ackCommand({
        commandId: cmd.commandId, status: "failed",
        resultSourceId: null, error: (err as Error).message
      }).catch(() => {});
      log(`command ${cmd.commandId} failed: ${(err as Error).message}`);
    } finally {
      conn.release();
    }
  }
}

let running = false;
async function tick(): Promise<void> {
  if (running) return; // never overlap ticks
  running = true;
  try {
    await captureAll();
    await drainOutbox();
    await processCommands();
  } catch (err) {
    log(`tick error: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

log(`starting against ${u.hostname}:${u.port} -> ${config.cloudUrl} (poll ${config.pollMs}ms)`);
await tick();
setInterval(tick, config.pollMs);
