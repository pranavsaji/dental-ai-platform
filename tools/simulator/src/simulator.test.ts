import { describe, expect, it } from "vitest";
import { createRng } from "./rng.js";
import { InMemoryPractice } from "./practice.js";
import { buildPractice } from "./model.js";
import { InMemoryOps } from "./ops.js";
import { runTick } from "./generators.js";
import { SCENARIOS } from "./scenarios.js";

const FROZEN = () => new Date("2026-07-08T12:00:00");

function snapshot(p: InMemoryPractice): string {
  const tables = ["patient", "appointment", "procedurelog", "claim", "payment", "commlog"];
  return JSON.stringify(tables.map((t) => p.rows(t)));
}

describe("practice simulator", () => {
  it("buildPractice is deterministic under a fixed seed", () => {
    const a = buildPractice(42, { now: FROZEN });
    const b = buildPractice(42, { now: FROZEN });
    expect(snapshot(a)).toBe(snapshot(b));
  });

  it("different seeds produce different practices", () => {
    const a = buildPractice(1, { now: FROZEN });
    const b = buildPractice(2, { now: FROZEN });
    expect(snapshot(a)).not.toBe(snapshot(b));
  });

  it("seeds the data richness Phase B–E features consume", () => {
    const p = buildPractice(42, { now: FROZEN });
    const plannedUnscheduled = p.rows("procedurelog")
      .filter((r) => r.ProcStatus === 1 && r.AptNum === 0);
    const deniedClaims = p.rows("claim").filter((r) => r.CarcCodes !== "");
    const payments = p.rows("payment");
    const optedOut = p.rows("patient").filter((r) => r.TxtMsgOk === 2);
    const unconfirmedFuture = p.rows("appointment")
      .filter((r) => r.AptStatus === 1 && r.Confirmed === 0);
    expect(plannedUnscheduled.length).toBeGreaterThan(0);
    expect(deniedClaims.length).toBeGreaterThan(0);
    expect(payments.length).toBeGreaterThan(0);
    expect(optedOut.length).toBeGreaterThan(0);
    expect(unconfirmedFuture.length).toBeGreaterThan(0);
    const plans = p.rows("insplan");
    expect(plans.every((r) => r.AnnualMax > 0 && r.ElectID !== "")).toBe(true);
  });

  it("rowsSince paginates in (stamp, pk) keyset order without loss", () => {
    const p = new InMemoryPractice(FROZEN);
    for (let i = 0; i < 25; i++) p.insert("payment", { PatNum: i + 1, PayAmt: i, PayDate: "2026-07-01", PayType: 1, PayNote: "" });
    let cursor = { stamp: "1970-01-01 00:00:00", pk: 0 };
    const seen: number[] = [];
    for (;;) {
      const page = p.rowsSince("payment", cursor, 10);
      if (page.length === 0) break;
      for (const r of page) seen.push(Number(r.PayNum));
      const last = page[page.length - 1];
      cursor = { stamp: last.DateTStamp, pk: Number(last.PayNum) };
    }
    expect(seen).toEqual([...Array(25)].map((_, i) => i + 1));
  });

  it("generator ticks are deterministic and mutate the practice", async () => {
    const run = async () => {
      const p = buildPractice(7, { now: FROZEN });
      const ops = new InMemoryOps(p);
      const rng = createRng(99);
      const log: (string | null)[] = [];
      for (let i = 0; i < 10; i++) log.push(await runTick(rng, ops));
      return { log, state: snapshot(p) };
    };
    const a = await run();
    const b = await run();
    expect(a.log).toEqual(b.log);
    expect(a.state).toBe(b.state);
    expect(a.log.filter(Boolean).length).toBeGreaterThan(0);
  });

  it("denial-storm scenario denies aging claims with CARC codes", async () => {
    const p = buildPractice(42, { now: FROZEN });
    const ops = new InMemoryOps(p);
    const before = p.rows("claim").filter((r) => r.CarcCodes !== "").length;
    const log = await SCENARIOS["denial-storm"].run(createRng(1), ops);
    const after = p.rows("claim").filter((r) => r.CarcCodes !== "").length;
    expect(after).toBeGreaterThan(before);
    expect(log.some((l) => l.includes("CARC"))).toBe(true);
  });

  it("flagship-loop cancels a future appointment", async () => {
    const p = buildPractice(42, { now: FROZEN });
    const ops = new InMemoryOps(p);
    const brokenBefore = p.rows("appointment").filter((r) => r.AptStatus === 5).length;
    await SCENARIOS["flagship-loop"].run(createRng(1), ops);
    const brokenAfter = p.rows("appointment").filter((r) => r.AptStatus === 5).length;
    expect(brokenAfter).toBe(brokenBefore + 1);
  });
});
