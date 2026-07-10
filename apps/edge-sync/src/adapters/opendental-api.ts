// OpenDentalApiAdapter: reads/writes through the OpenDental REST API instead
// of direct MySQL. Rows come back OD-shaped (PascalCase, DateTStamp strings),
// so they flow through the same transformRow mapping as every other adapter.
//
// Incremental reads use the DateTStamp query param where OD supports it; the
// adapter also filters client-side against the cursor, which doubles as the
// full-page-diff strategy for endpoints without server-side filtering.
// Integration-tested against tools/mock-od-api (no real OD install in dev).

import type { CommandPayload, SyncTable } from "@dental/shared";
import type { TableCursor } from "../state.js";
import { TABLE_META, transformRow } from "../transform.js";
import type { AdapterHealth, CaptureResult, PmsAdapter } from "./adapter.js";

// OD API resource paths per logical table.
const ENDPOINTS: Record<SyncTable, string> = {
  provider: "providers",
  operatory: "operatories",
  procedurecode: "procedurecodes",
  patient: "patients",
  appointment: "appointments",
  procedurelog: "procedurelogs",
  insplan: "insplans",
  patplan: "patplans",
  claim: "claims",
  claimproc: "claimprocs",
  recall: "recalls",
  commlog: "commlogs",
  payment: "payments"
};

export interface OdApiConfig {
  baseUrl: string; // e.g. https://api.opendental.com/api/v1 or the local fixture server
  developerKey: string;
  customerKey: string;
}

export class OpenDentalApiAdapter implements PmsAdapter {
  readonly mode = "api" as const;

  constructor(private cfg: OdApiConfig) {
    if (!cfg.baseUrl) throw new Error("OD_API_URL is required for PMS_MODE=api");
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        // ODApi auth: developer + customer key pair.
        authorization: `ODFHIR ${this.cfg.developerKey}/${this.cfg.customerKey}`,
        ...init?.headers
      },
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OD API ${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json() as Promise<T>;
  }

  async capture(table: SyncTable, cursor: TableCursor, limit: number): Promise<CaptureResult> {
    const meta = TABLE_META[table];
    // The OD API filters by DateTStamp and pages by limit/offset; it has no
    // keyset (stamp, pk) cursor. Page server-side until we have `limit` rows
    // past our cursor (or the pages run out), then re-apply the keyset
    // predicate + ordering client-side — this also makes endpoints without
    // server-side stamp filtering degrade safely to full-page diff.
    const past: any[] = [];
    for (let offset = 0; ; ) {
      const page = await this.call<any[]>(
        `/${ENDPOINTS[table]}?DateTStamp=${encodeURIComponent(cursor.stamp)}&limit=${limit}&offset=${offset}`
      );
      past.push(...page.filter((r) =>
        String(r.DateTStamp) > cursor.stamp ||
        (String(r.DateTStamp) === cursor.stamp && Number(r[meta.pk]) > cursor.pk)));
      if (page.length < limit || past.length >= limit) break;
      offset += page.length;
    }
    const rows = past
      .sort((a, b) =>
        String(a.DateTStamp) < String(b.DateTStamp) ? -1 :
        String(a.DateTStamp) > String(b.DateTStamp) ? 1 :
        Number(a[meta.pk]) - Number(b[meta.pk]))
      .slice(0, limit);
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
        const res = await this.call<{ AptNum: number }>("/appointments", {
          method: "POST",
          body: JSON.stringify({
            PatNum: command.patientSourceId,
            ProvNum: command.providerSourceId,
            Op: command.operatorySourceId,
            AptDateTime: command.startsAt.replace("T", " ").slice(0, 19),
            Pattern: "X".repeat(Math.round(command.minutes / 5)),
            AptStatus: 1,
            Confirmed: 2,
            Note: command.note,
            ProcDescript: command.procDescript
          })
        });
        return { sourceId: res.AptNum };
      }
      case "UpdateAppointmentStatus": {
        const statusToOd: Record<string, number> = { scheduled: 1, complete: 2, unscheduled: 3, broken: 5 };
        await this.call(`/appointments/${command.appointmentSourceId}`, {
          method: "PUT",
          body: JSON.stringify({ AptStatus: statusToOd[command.status] })
        });
        return { sourceId: command.appointmentSourceId };
      }
      case "ConfirmAppointment": {
        await this.call(`/appointments/${command.appointmentSourceId}`, {
          method: "PUT",
          body: JSON.stringify({ Confirmed: 2 })
        });
        return { sourceId: command.appointmentSourceId };
      }
      case "AddCommlog": {
        const res = await this.call<{ CommlogNum: number }>("/commlogs", {
          method: "POST",
          body: JSON.stringify({
            PatNum: command.patientSourceId,
            CommType: command.commType,
            Note: command.note,
            Mode_: command.mode,
            SentOrReceived: command.sentOrReceived
          })
        });
        return { sourceId: res.CommlogNum };
      }
    }
  }

  async health(): Promise<AdapterHealth> {
    try {
      await this.call<any[]>("/providers?limit=1");
      return { ok: true, detail: "OD API reachable" };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }
}
