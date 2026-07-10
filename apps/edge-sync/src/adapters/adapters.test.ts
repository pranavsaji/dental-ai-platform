import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS, type SyncTable } from "@dental/shared";
import { createMockOdApi, type MockOdApi } from "@dental/mock-od-api";
import { SYNC_ORDER } from "../transform.js";
import type { TableCursor } from "../state.js";
import { MockAdapter } from "./mock.js";
import { OpenDentalApiAdapter } from "./opendental-api.js";
import type { PmsAdapter } from "./adapter.js";

const EPOCH: TableCursor = { stamp: "1970-01-01 00:00:00", pk: 0 };

async function drain(adapter: PmsAdapter, table: SyncTable) {
  const all: Awaited<ReturnType<PmsAdapter["capture"]>>["rows"] = [];
  let cursor = EPOCH;
  for (;;) {
    const { rows, next } = await adapter.capture(table, cursor, 50);
    if (rows.length === 0) return { rows: all, cursor };
    all.push(...rows);
    cursor = next!;
  }
}

describe("MockAdapter", () => {
  const adapter = new MockAdapter({ seed: 42, tickMs: 0 });

  it("serves the full seeded practice as schema-valid canonical payloads", async () => {
    for (const table of SYNC_ORDER) {
      const { rows } = await drain(adapter, table);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) {
        expect(() => PAYLOAD_SCHEMAS[table].parse(r.payload), table).not.toThrow();
      }
    }
  });

  it("round-trips a booking: apply echoes back through capture", async () => {
    const { cursor } = await drain(adapter, "appointment");
    const { sourceId } = await adapter.apply({
      type: "BookAppointment", patientSourceId: 1, providerSourceId: 1,
      operatorySourceId: 2, startsAt: "2026-08-03T10:00:00", minutes: 30,
      procDescript: "Comp1P", note: "booked by test"
    });
    expect(sourceId).toBeGreaterThan(0);
    const { rows } = await adapter.capture("appointment", cursor, 50);
    const echoed = rows.find((r) => r.sourceId === sourceId);
    expect(echoed).toBeTruthy();
    expect((echoed!.payload as any).startsAt).toBe("2026-08-03T10:00:00");
  });

  it("applies status updates and commlogs", async () => {
    const { rows } = await adapter.capture("appointment", EPOCH, 1);
    const aptNum = rows[0].sourceId;
    await adapter.apply({ type: "UpdateAppointmentStatus", appointmentSourceId: aptNum, status: "broken" });
    const again = await drain(adapter, "appointment");
    const updated = again.rows.find((r) => r.sourceId === aptNum);
    expect((updated!.payload as any).status).toBe("broken");

    const { sourceId } = await adapter.apply({
      type: "AddCommlog", patientSourceId: 1, note: "test note", commType: 2, mode: 1, sentOrReceived: 1
    });
    expect(sourceId).toBeGreaterThan(0);
  });

  it("reports healthy", async () => {
    expect((await adapter.health()).ok).toBe(true);
  });
});

describe("OpenDentalApiAdapter (against the mock OD API fixture)", () => {
  let api: MockOdApi;
  let adapter: OpenDentalApiAdapter;

  beforeAll(async () => {
    api = createMockOdApi({ seed: 7 });
    const port = await api.listen(0);
    adapter = new OpenDentalApiAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      developerKey: "dev", customerKey: "cust"
    });
  });

  afterAll(async () => {
    await api.close();
  });

  it("captures schema-valid payloads for every table", async () => {
    for (const table of SYNC_ORDER) {
      const { rows } = await drain(adapter, table);
      expect(rows.length, table).toBeGreaterThan(0);
      for (const r of rows) {
        expect(() => PAYLOAD_SCHEMAS[table].parse(r.payload), table).not.toThrow();
      }
    }
  });

  it("captures incrementally past the cursor", async () => {
    const { cursor } = await drain(adapter, "patient");
    const idle = await adapter.capture("patient", cursor, 50);
    expect(idle.rows).toHaveLength(0);
    api.practice.update("patient", 3, { WirelessPhone: "(512) 555-9999" });
    const { rows } = await adapter.capture("patient", cursor, 50);
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe(3);
    expect((rows[0].payload as any).wirelessPhone).toBe("(512) 555-9999");
  });

  it("writes through the API: booking, status update, commlog", async () => {
    const booked = await adapter.apply({
      type: "BookAppointment", patientSourceId: 2, providerSourceId: 1,
      operatorySourceId: 3, startsAt: "2026-08-04T09:00:00", minutes: 40,
      procDescript: "ProphyAd", note: "via API"
    });
    expect(booked.sourceId).toBeGreaterThan(0);
    expect(api.practice.get("appointment", booked.sourceId)!.AptStatus).toBe(1);

    await adapter.apply({ type: "UpdateAppointmentStatus", appointmentSourceId: booked.sourceId, status: "complete" });
    expect(api.practice.get("appointment", booked.sourceId)!.AptStatus).toBe(2);

    const comm = await adapter.apply({
      type: "AddCommlog", patientSourceId: 2, note: "api note", commType: 1, mode: 5, sentOrReceived: 1
    });
    expect(api.practice.get("commlog", comm.sourceId)!.Note).toBe("api note");
  });

  it("health goes false when the API is unreachable", async () => {
    const dead = new OpenDentalApiAdapter({
      baseUrl: "http://127.0.0.1:1", developerKey: "d", customerKey: "c"
    });
    expect((await dead.health()).ok).toBe(false);
    expect((await adapter.health()).ok).toBe(true);
  });
});
