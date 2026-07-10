// MySqlAdapter: the original capture/write-back path, extracted behind the
// PmsAdapter interface with zero behavior change — same keyset query, same
// transformRow mapping, same transactional applyCommand.

import mysql from "mysql2/promise";
import type { CommandPayload, SyncTable } from "@dental/shared";
import type { TableCursor } from "../state.js";
import { TABLE_META, transformRow } from "../transform.js";
import { applyCommand } from "../writeback.js";
import type { AdapterHealth, CaptureResult, PmsAdapter } from "./adapter.js";

export class MySqlAdapter implements PmsAdapter {
  readonly mode = "mysql" as const;
  private pool: mysql.Pool;

  constructor(mysqlUrl: string) {
    const u = new URL(mysqlUrl);
    this.pool = mysql.createPool({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      dateStrings: true, // temporal columns as strings; avoids TZ reinterpretation
      connectionLimit: 4
    });
  }

  async capture(table: SyncTable, cursor: TableCursor, limit: number): Promise<CaptureResult> {
    const meta = TABLE_META[table];
    // Keyset pagination on (stamp, pk): advances through bulk changes that share
    // one TIMESTAMP second instead of refetching them forever.
    const [rows] = await this.pool.query<any[]>(
      `SELECT * FROM ${table}
       WHERE (${meta.stampCol} > ?) OR (${meta.stampCol} = ? AND ${meta.pk} > ?)
       ORDER BY ${meta.stampCol} ASC, ${meta.pk} ASC LIMIT ?`,
      [cursor.stamp, cursor.stamp, cursor.pk, limit]
    );
    if (rows.length === 0) return { rows: [], next: null };
    const last = rows[rows.length - 1];
    return {
      rows: rows.map((r) => ({
        sourceId: Number(r[meta.pk]),
        stamp: String(r[meta.stampCol]),
        payload: transformRow(table, r)
      })),
      next: { stamp: String(last[meta.stampCol]), pk: Number(last[meta.pk]) }
    };
  }

  async apply(command: CommandPayload): Promise<{ sourceId: number }> {
    const conn = await this.pool.getConnection();
    try {
      const sourceId = await applyCommand(conn, command);
      return { sourceId };
    } finally {
      conn.release();
    }
  }

  async health(): Promise<AdapterHealth> {
    try {
      await this.pool.query("SELECT 1");
      return { ok: true, detail: "mysql reachable" };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
