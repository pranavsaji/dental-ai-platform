import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SyncEvent } from "@dental/shared";

// Durable local state. Written atomically (tmp + rename) after every batch so
// a crash never loses the outbox or replays from the beginning of time.

// Keyset cursor: rows are consumed in (DateTStamp, PK) order so bulk changes
// sharing one timestamp (an import, a big seed) still paginate forward.
export interface TableCursor {
  stamp: string; // "YYYY-MM-DD HH:MM:SS"
  pk: number;
}

export interface EdgeState {
  cursors: Record<string, TableCursor>;
  outbox: SyncEvent[]; // captured but not yet acknowledged by the cloud
  appliedCommandIds: string[]; // guards against re-applying a command if the ack was lost
}

export class StateStore {
  private state: EdgeState;

  constructor(private file: string) {
    if (existsSync(file)) {
      this.state = JSON.parse(readFileSync(file, "utf8"));
    } else {
      this.state = { cursors: {}, outbox: [], appliedCommandIds: [] };
    }
  }

  get(): EdgeState {
    return this.state;
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }

  cursor(table: string): TableCursor {
    const c = this.state.cursors[table] as TableCursor | string | undefined;
    if (!c) return { stamp: "1970-01-01 00:00:00", pk: 0 };
    if (typeof c === "string") return { stamp: c, pk: 0 }; // migrate old shape
    return c;
  }

  setCursor(table: string, cursor: TableCursor): void {
    this.state.cursors[table] = cursor;
  }

  enqueue(events: SyncEvent[]): void {
    const seen = new Set(this.state.outbox.map((e) => e.eventId));
    for (const e of events) if (!seen.has(e.eventId)) this.state.outbox.push(e);
  }

  dequeue(count: number): void {
    this.state.outbox.splice(0, count);
  }

  markCommandApplied(commandId: string): void {
    this.state.appliedCommandIds.push(commandId);
    if (this.state.appliedCommandIds.length > 1000) {
      this.state.appliedCommandIds = this.state.appliedCommandIds.slice(-500);
    }
  }

  wasCommandApplied(commandId: string): boolean {
    return this.state.appliedCommandIds.includes(commandId);
  }
}
