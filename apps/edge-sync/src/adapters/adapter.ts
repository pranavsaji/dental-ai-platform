// PmsAdapter (A1): the pluggable boundary between the edge synchronizer and
// whatever practice-management system actually exists at a site.
//
//   PMS_MODE=api    OpenDental REST API + webhook hints
//   PMS_MODE=mysql  DateTStamp keyset polling of OpenDental MySQL (the original path)
//   PMS_MODE=mock   embedded practice simulator — no PMS at all
//
// Every mode implements the same three operations, so main.ts contains zero
// PMS-specific logic and fallback is a pointer swap.

import type { CommandPayload, PmsMode, SyncTable } from "@dental/shared";
import type { TableCursor } from "../state.js";

export interface CapturedRow {
  sourceId: number;
  /** Raw PMS row stamp, "YYYY-MM-DD HH:MM:SS" — flows into the eventId. */
  stamp: string;
  /** Canonical payload (transformRow output) — validated by the cloud. */
  payload: unknown;
}

export interface CaptureResult {
  rows: CapturedRow[];
  /** Cursor to persist after the rows are enqueued; null = unchanged. */
  next: TableCursor | null;
}

export interface AdapterHealth {
  ok: boolean;
  detail: string;
}

export interface PmsAdapter {
  readonly mode: PmsMode;
  /** Pull changes past the cursor for one logical table. */
  capture(table: SyncTable, cursor: TableCursor, limit: number): Promise<CaptureResult>;
  /** Apply a cloud command; returns the PMS-native id created/affected. */
  apply(command: CommandPayload): Promise<{ sourceId: number }>;
  /** Liveness — drives automatic fallback + the edge heartbeat status. */
  health(): Promise<AdapterHealth>;
  close(): Promise<void>;
}
