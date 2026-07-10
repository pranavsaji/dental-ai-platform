import { describe, expect, it } from "vitest";
import { computeNoShowRisk } from "@dental/shared";
import { findOpenSlots, type BusyInterval } from "./slots";

// Phase C unit tests: the no-show scorer (C4) and the slot finder (C3) are
// the deterministic cores the workflows lean on — both must be exact.

describe("computeNoShowRisk (C4)", () => {
  const base = {
    pastAppointments: 10,
    pastNoShows: 0,
    priorLateCancels: 0,
    confirmed: true,
    leadTimeDays: 2,
    isNewPatient: false,
    startHour: 10,
    dayOfWeek: 3 // Wednesday
  };

  it("scores a reliable confirmed regular at zero", () => {
    const s = computeNoShowRisk(base);
    expect(s.risk).toBe(0);
    expect(s.factors).toEqual([]);
  });

  it("weights the chronic no-show history hardest", () => {
    const s = computeNoShowRisk({ ...base, pastNoShows: 5 }); // 50% rate
    expect(s.risk).toBeCloseTo(0.15, 2); // 0.30 × 0.5
    expect(s.factors[0].key).toBe("past_no_shows");
    expect(s.factors[0].detail).toContain("5 prior no-shows in 10 visits");
  });

  it("stacks every factor per the plan formula", () => {
    const s = computeNoShowRisk({
      pastAppointments: 4,
      pastNoShows: 4,       // rate 1.0 → 0.30
      priorLateCancels: 2,  // → 0.10
      confirmed: false,     // → 0.20
      leadTimeDays: 45,     // ≥30 → 0.15
      isNewPatient: true,   // → 0.15
      startHour: 17,        // evening → 0.10
      dayOfWeek: 5
    });
    expect(s.risk).toBe(1); // 1.0 total, clamped
    expect(s.factors).toHaveLength(6);
  });

  it("flags Monday slots like evening slots, but only once", () => {
    const monday = computeNoShowRisk({ ...base, dayOfWeek: 1 });
    const eveningMonday = computeNoShowRisk({ ...base, dayOfWeek: 1, startHour: 17 });
    expect(monday.risk).toBe(0.1);
    expect(eveningMonday.risk).toBe(0.1);
  });

  it("buckets lead time (7 / 14 / 30 day steps)", () => {
    expect(computeNoShowRisk({ ...base, leadTimeDays: 6 }).risk).toBe(0);
    expect(computeNoShowRisk({ ...base, leadTimeDays: 8 }).risk).toBeCloseTo(0.05, 2);
    expect(computeNoShowRisk({ ...base, leadTimeDays: 20 }).risk).toBeCloseTo(0.09, 2);
    expect(computeNoShowRisk({ ...base, leadTimeDays: 40 }).risk).toBeCloseTo(0.15, 2);
  });

  it("never divides by zero for a brand-new patient", () => {
    const s = computeNoShowRisk({ ...base, pastAppointments: 0, isNewPatient: true });
    expect(s.risk).toBe(0.15);
    expect(s.factors.map((f) => f.key)).toEqual(["new_patient"]);
  });
});

describe("findOpenSlots (C3)", () => {
  // Wednesday 2026-07-08 12:00 as "now" — deterministic regardless of run time.
  const from = new Date("2026-07-08T12:00:00");

  const q = {
    providerSourceId: 1,
    operatorySourceId: 2,
    minutes: 60,
    from,
    days: 14,
    count: 3
  };

  it("offers the first opening of three distinct business days", () => {
    const slots = findOpenSlots([], q);
    expect(slots).toHaveLength(3);
    const days = slots.map((s) => s.startsAt.toDateString());
    expect(new Set(days).size).toBe(3);
    for (const s of slots) {
      expect([0, 6]).not.toContain(s.startsAt.getDay());
      expect(s.startsAt.getHours()).toBe(8); // empty book → 8:00 openings
      expect(s.operatorySourceId).toBe(2);
      expect(s.providerSourceId).toBe(1);
    }
  });

  it("skips conflicts in the same operatory OR with the same provider", () => {
    const thursday8 = new Date("2026-07-09T08:00:00");
    const busy: BusyInterval[] = [
      // same operatory, different provider — blocks
      { startsAt: thursday8, minutes: 60, operatorySourceId: 2, providerSourceId: 9 },
      // same provider, different operatory, 9:00 — blocks the next grid slot
      { startsAt: new Date("2026-07-09T09:00:00"), minutes: 30, operatorySourceId: 5, providerSourceId: 1 }
    ];
    const slots = findOpenSlots(busy, q);
    const thursday = slots.find((s) => s.startsAt.getDate() === 9)!;
    // 8:00 and 9:00 blocked; 8:30 overlaps the 60-min 8:00 booking → 9:30.
    expect(thursday.startsAt.getHours()).toBe(9);
    expect(thursday.startsAt.getMinutes()).toBe(30);
  });

  it("ignores bookings in unrelated operatories with other providers", () => {
    const busy: BusyInterval[] = [
      { startsAt: new Date("2026-07-09T08:00:00"), minutes: 480, operatorySourceId: 7, providerSourceId: 9 }
    ];
    const slots = findOpenSlots(busy, q);
    expect(slots[0].startsAt.getHours()).toBe(8);
  });

  it("respects the window and never offers weekends", () => {
    // Fill every weekday grid slot in op 2 for the full window.
    const busy: BusyInterval[] = [];
    for (let d = 1; d <= 14; d++) {
      const day = new Date(from);
      day.setDate(day.getDate() + d);
      const start = new Date(day);
      start.setHours(8, 0, 0, 0);
      busy.push({ startsAt: start, minutes: 9 * 60, operatorySourceId: 2, providerSourceId: 1 });
    }
    expect(findOpenSlots(busy, q)).toHaveLength(0);
  });
});
