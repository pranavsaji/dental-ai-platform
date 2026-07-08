import { describe, expect, it } from "vitest";
import { normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("normalizes OpenDental-style formatted numbers", () => {
    expect(normalizePhone("(512) 555-0142")).toBe("+15125550142");
    expect(normalizePhone("512.555.0142")).toBe("+15125550142");
    expect(normalizePhone("512 555 0142")).toBe("+15125550142");
  });

  it("handles country-code variants", () => {
    expect(normalizePhone("15125550142")).toBe("+15125550142");
    expect(normalizePhone("+1 512 555 0142")).toBe("+15125550142");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("rejects undialable strings", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("n/a")).toBeNull();
    expect(normalizePhone("555-0142")).toBeNull(); // 7 digits
    expect(normalizePhone("25125550142")).toBeNull(); // 11 digits, not US
  });
});
