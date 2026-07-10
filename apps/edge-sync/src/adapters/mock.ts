// MockAdapter: no PMS at all. Wraps the practice simulator's in-memory model —
// capture drains the model's change feed through the same transformRow mapping
// the MySQL path uses, and apply mutates the model and echoes the change back
// through the feed, so a mock booking still round-trips to the dashboard.

import {
  InMemoryOps, InMemoryPractice, buildPractice, createRng, runTick, type Rng
} from "@dental/simulator";
import type { CommandPayload, SyncTable } from "@dental/shared";
import type { TableCursor } from "../state.js";
import { TABLE_META, transformRow } from "../transform.js";
import type { AdapterHealth, CaptureResult, PmsAdapter } from "./adapter.js";

const APT_STATUS_TO_OD: Record<string, number> = {
  scheduled: 1, complete: 2, unscheduled: 3, broken: 5
};

export interface MockAdapterOptions {
  seed?: number;
  /** Live-activity tick in ms; 0 disables ongoing simulation (tests). */
  tickMs?: number;
  onEvent?: (description: string) => void;
}

export class MockAdapter implements PmsAdapter {
  readonly mode = "mock" as const;
  readonly practice: InMemoryPractice;
  private ops: InMemoryOps;
  private rng: Rng;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: MockAdapterOptions = {}) {
    this.practice = buildPractice(opts.seed ?? 1);
    this.ops = new InMemoryOps(this.practice);
    this.rng = createRng((opts.seed ?? 1) * 7919 + 17);
    const tickMs = opts.tickMs ?? 30_000;
    if (tickMs > 0) {
      this.timer = setInterval(() => {
        runTick(this.rng, this.ops)
          .then((desc) => { if (desc && opts.onEvent) opts.onEvent(desc); })
          .catch(() => {});
      }, tickMs);
      this.timer.unref?.();
    }
  }

  async capture(table: SyncTable, cursor: TableCursor, limit: number): Promise<CaptureResult> {
    const meta = TABLE_META[table];
    const rows = this.practice.rowsSince(table, cursor, limit);
    if (rows.length === 0) return { rows: [], next: null };
    const last = rows[rows.length - 1];
    return {
      rows: rows.map((r) => ({
        sourceId: Number(r[meta.pk]),
        stamp: String(r.DateTStamp),
        payload: transformRow(table, r)
      })),
      next: { stamp: String(last.DateTStamp), pk: Number(last[meta.pk]) }
    };
  }

  async apply(command: CommandPayload): Promise<{ sourceId: number }> {
    switch (command.type) {
      case "BookAppointment": {
        const aptNum = this.practice.insert("appointment", {
          PatNum: command.patientSourceId, AptStatus: 1,
          Pattern: "X".repeat(Math.round(command.minutes / 5)), Confirmed: 2,
          Op: command.operatorySourceId, ProvNum: command.providerSourceId,
          AptDateTime: command.startsAt.replace("T", " ").slice(0, 19),
          Note: command.note, ProcDescript: command.procDescript
        });
        return { sourceId: aptNum };
      }
      case "UpdateAppointmentStatus": {
        if (!this.practice.get("appointment", command.appointmentSourceId)) {
          throw new Error(`AptNum ${command.appointmentSourceId} not found`);
        }
        this.practice.update("appointment", command.appointmentSourceId, {
          AptStatus: APT_STATUS_TO_OD[command.status]
        });
        return { sourceId: command.appointmentSourceId };
      }
      case "ConfirmAppointment": {
        if (!this.practice.get("appointment", command.appointmentSourceId)) {
          throw new Error(`AptNum ${command.appointmentSourceId} not found`);
        }
        this.practice.update("appointment", command.appointmentSourceId, { Confirmed: 2 });
        return { sourceId: command.appointmentSourceId };
      }
      case "AddCommlog": {
        const now = this.practice.now();
        const p = (n: number) => String(n).padStart(2, "0");
        const commlogNum = this.practice.insert("commlog", {
          PatNum: command.patientSourceId,
          CommDateTime: `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`,
          CommType: command.commType, Note: command.note,
          Mode_: command.mode, SentOrReceived: command.sentOrReceived
        });
        return { sourceId: commlogNum };
      }
    }
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: "embedded simulator" };
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}
