import { describe, expect, it } from "vitest";
import {
  evaluateMessagePolicy, isOptOutMessage, localDayStartUtc, localHour,
  nextQuietWindowEnd, type PolicyInput
} from "./policy";

// America/Chicago is CDT (UTC-5) in July — 17:00Z = noon local.
const NOON_LOCAL = new Date("2026-07-11T17:00:00Z");
const TEN_PM_LOCAL = new Date("2026-07-12T03:00:00Z");
const SIX_AM_LOCAL = new Date("2026-07-11T11:00:00Z");

function base(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    kind: "outreach",
    consent: true,
    optedOut: false,
    now: NOON_LOCAL,
    timezone: "America/Chicago",
    sentToday: 0,
    sentThisWeek: 0,
    ...overrides
  };
}

describe("evaluateMessagePolicy", () => {
  it("allows consented outreach midday under the caps", () => {
    expect(evaluateMessagePolicy(base())).toEqual({ action: "send" });
  });

  it("blocks on missing consent for every kind", () => {
    for (const kind of ["outreach", "conversation", "confirmation", "notice"] as const) {
      const d = evaluateMessagePolicy(base({ kind, consent: false }));
      expect(d.action).toBe("block");
      expect((d as any).reason).toBe("blocked_consent");
    }
  });

  it("blocks on sticky opt-out even when the consent flag says yes", () => {
    const d = evaluateMessagePolicy(base({ optedOut: true, consent: true }));
    expect(d).toMatchObject({ action: "block", reason: "blocked_consent" });
  });

  it("defers evening outreach to 08:00 patient-local next morning", () => {
    const d = evaluateMessagePolicy(base({ now: TEN_PM_LOCAL }));
    expect(d.action).toBe("defer");
    const sendAt = (d as any).sendAt as Date;
    // 08:00 CDT on 2026-07-12 = 13:00Z
    expect(sendAt.toISOString()).toBe("2026-07-12T13:00:00.000Z");
  });

  it("defers early-morning outreach to 08:00 the same day", () => {
    const d = evaluateMessagePolicy(base({ now: SIX_AM_LOCAL }));
    expect(d.action).toBe("defer");
    expect((d as any).sendAt.toISOString()).toBe("2026-07-11T13:00:00.000Z");
  });

  it("respects the patient's own timezone, not the server's", () => {
    // 17:00Z = 10:00 in Los Angeles — allowed there, even though it's noon in Chicago.
    const d = evaluateMessagePolicy(base({ timezone: "America/Los_Angeles", now: NOON_LOCAL }));
    expect(d.action).toBe("send");
    // …and 04:00Z = 21:00 in LA the previous evening — quiet hours.
    const evening = evaluateMessagePolicy(base({ timezone: "America/Los_Angeles", now: new Date("2026-07-12T04:00:00Z") }));
    expect(evening.action).toBe("defer");
  });

  it("blocks outreach at the daily and weekly caps", () => {
    expect(evaluateMessagePolicy(base({ sentToday: 2 })))
      .toMatchObject({ action: "block", reason: "blocked_frequency" });
    expect(evaluateMessagePolicy(base({ sentToday: 1, sentThisWeek: 6 })))
      .toMatchObject({ action: "block", reason: "blocked_frequency" });
    expect(evaluateMessagePolicy(base({ sentToday: 1, sentThisWeek: 5 })))
      .toEqual({ action: "send" });
  });

  it("exempts confirmations and conversation replies from caps and quiet hours", () => {
    for (const kind of ["conversation", "confirmation", "notice"] as const) {
      const d = evaluateMessagePolicy(base({ kind, now: TEN_PM_LOCAL, sentToday: 5, sentThisWeek: 20 }));
      expect(d).toEqual({ action: "send" });
    }
  });

  it("falls back to the seeded default zone on a garbage timezone", () => {
    const d = evaluateMessagePolicy(base({ timezone: "Not/AZone" }));
    expect(d.action).toBe("send"); // noon in America/Chicago
  });
});

describe("local time helpers", () => {
  it("computes the patient-local hour", () => {
    expect(localHour(NOON_LOCAL, "America/Chicago")).toBe(12);
    expect(localHour(TEN_PM_LOCAL, "America/Chicago")).toBe(22);
    expect(localHour(new Date("2026-07-12T05:00:00Z"), "America/Chicago")).toBe(0);
  });

  it("computes the UTC instant of the local day start", () => {
    // Chicago day starts at 05:00Z during CDT.
    expect(localDayStartUtc(NOON_LOCAL, "America/Chicago").toISOString())
      .toBe("2026-07-11T05:00:00.000Z");
  });

  it("finds the next 08:00 local across midnight", () => {
    expect(nextQuietWindowEnd(TEN_PM_LOCAL, "America/Chicago").toISOString())
      .toBe("2026-07-12T13:00:00.000Z");
  });
});

describe("isOptOutMessage", () => {
  it("matches the STOP vocabulary", () => {
    for (const t of ["STOP", "stop", " Stop please", "UNSUBSCRIBE", "opt out", "opt-out", "optout", "STOPALL"]) {
      expect(isOptOutMessage(t)).toBe(true);
    }
  });
  it("does not match appointment-cancellation language or ordinary replies", () => {
    for (const t of ["cancel", "CANCEL", "cancel my appointment", "yes", "no", "please stop by anytime"]) {
      expect(isOptOutMessage(t)).toBe(false);
    }
  });
});
