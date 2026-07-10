import { describe, expect, it } from "vitest";
import { PAYLOAD_SCHEMAS } from "@dental/shared";
import { SYNC_ORDER, transformRow } from "./transform.js";

describe("transformRow", () => {
  it("maps OpenDental patient rows to the canonical payload", () => {
    const payload = transformRow("patient", {
      PatNum: 42, LName: "Haley", FName: "Arthur", Birthdate: "1988-03-02",
      Gender: 0, PatStatus: 0, HmPhone: "", WirelessPhone: "(512) 555-0100",
      Email: "a@example.com", Address: "1 Main St", City: "Austin", State: "TX",
      Zip: "78701", PriProv: 1, SecDateEntry: "2020-01-15", TxtMsgOk: 1
    }) as any;
    expect(payload.gender).toBe("male");
    expect(payload.status).toBe("active");
    expect(payload.birthdate).toBe("1988-03-02");
    expect(payload.smsConsent).toBe(true);
    expect(PAYLOAD_SCHEMAS.patient.parse(payload)).toBeTruthy();
  });

  it("maps TxtMsgOk=2 to an SMS opt-out", () => {
    const optedOut = transformRow("patient", {
      PatNum: 7, LName: "Q", FName: "P", Birthdate: "1970-01-02", Gender: 1,
      PatStatus: 0, HmPhone: "", WirelessPhone: "(512) 555-0111", Email: "",
      Address: "", City: "", State: "", Zip: "", PriProv: 1,
      SecDateEntry: "2021-05-01", TxtMsgOk: 2
    }) as any;
    expect(optedOut.smsConsent).toBe(false);
  });

  it("nulls OpenDental's 0001-01-01 sentinel dates", () => {
    const payload = transformRow("patient", {
      PatNum: 1, LName: "", FName: "", Birthdate: "0001-01-01", Gender: 2,
      PatStatus: 4, HmPhone: "", WirelessPhone: "", Email: "", Address: "",
      City: "", State: "", Zip: "", PriProv: 0, SecDateEntry: "0001-01-01"
    }) as any;
    expect(payload.birthdate).toBeNull();
    expect(payload.firstVisit).toBeNull();
    expect(payload.status).toBe("archived");
  });

  it("maps appointment status codes and derives minutes from the pattern", () => {
    const payload = transformRow("appointment", {
      AptNum: 664, PatNum: 104, AptStatus: 5, Pattern: "XXXXXXXX", Confirmed: 2,
      Op: 6, ProvNum: 4, AptDateTime: "2026-07-08 08:00:00", Note: "", ProcDescript: "ProphyAd"
    }) as any;
    expect(payload.status).toBe("broken");
    expect(payload.minutes).toBe(40); // 8 pattern chars * 5 min
    expect(payload.startsAt).toBe("2026-07-08T08:00:00");
    expect(payload.confirmed).toBe(true);
    expect(PAYLOAD_SCHEMAS.appointment.parse(payload)).toBeTruthy();
  });

  it("maps claim status letters and carries CARC codes", () => {
    const payload = transformRow("claim", {
      ClaimNum: 1, PatNum: 2, DateService: "2026-01-10", DateSent: "2026-01-12",
      ClaimStatus: "S", ClaimFee: 250, InsPayEst: 150, InsPayAmt: 0,
      PlanNum: 3, ProvTreat: 1, ClaimNote: "", CarcCodes: "16,97"
    }) as any;
    expect(payload.status).toBe("sent");
    expect(payload.carcCodes).toBe("16,97");
    expect(PAYLOAD_SCHEMAS.claim.parse(payload)).toBeTruthy();
  });

  it("maps payment rows for the collections data path", () => {
    const payload = transformRow("payment", {
      PayNum: 9, PatNum: 4, PayDate: "2026-06-01", PayAmt: 182.5,
      PayType: 2, PayNote: "card on file"
    }) as any;
    expect(payload.amount).toBe(182.5);
    expect(payload.payDate).toBe("2026-06-01");
    expect(PAYLOAD_SCHEMAS.payment.parse(payload)).toBeTruthy();
  });

  it("orders reference tables before dependents for initial sync", () => {
    expect(SYNC_ORDER.indexOf("patient")).toBeLessThan(SYNC_ORDER.indexOf("appointment"));
    expect(SYNC_ORDER.indexOf("provider")).toBeLessThan(SYNC_ORDER.indexOf("patient"));
    expect(SYNC_ORDER.indexOf("claim")).toBeLessThan(SYNC_ORDER.indexOf("claimproc"));
  });

  it("every transformed table validates against its shared contract", () => {
    // Guards the edge <-> cloud boundary: a payload the edge produces must
    // always parse under the schema the cloud enforces.
    const samples: Record<string, Record<string, unknown>> = {
      provider: { ProvNum: 1, Abbr: "DDS1", LName: "L", FName: "F", Specialty: 0, IsHidden: 0 },
      operatory: { OperatoryNum: 1, OpName: "Op 1", Abbrev: "OP1", ItemOrder: 1, ProvDentist: 1, IsHidden: 0 },
      procedurecode: { CodeNum: 1, ProcCode: "D1110", Descript: "Prophy", AbbrDesc: "Pro" },
      insplan: { PlanNum: 1, GroupName: "G", GroupNum: "1", CarrierName: "C", PlanType: "p", CarrierPhone: "(800) 555-0000", ElectID: "94276", AnnualMax: 1500, Deductible: 50 },
      patplan: { PatPlanNum: 1, PatNum: 1, PlanNum: 1, Ordinal: 1, SubscriberID: "123" },
      recall: { RecallNum: 1, PatNum: 1, DateDue: "2026-01-01", DatePrevious: "2025-07-01", IsDisabled: 0 },
      commlog: { CommlogNum: 1, PatNum: 1, CommDateTime: "2026-01-01 09:00:00", CommType: 3, Note: "n", Mode_: 4, SentOrReceived: 0 },
      procedurelog: { ProcNum: 1, PatNum: 1, AptNum: 1, ProcDate: "2026-01-01", ProcFee: 100, ProcStatus: 2, ProvNum: 1, CodeNum: 1, ToothNum: "3", Surf: "" },
      claimproc: { ClaimProcNum: 1, ClaimNum: 1, ProcNum: 1, PatNum: 1, PlanNum: 1, Status: 1, FeeBilled: 100, InsPayEst: 60, InsPayAmt: 60, WriteOff: 15 },
      payment: { PayNum: 1, PatNum: 1, PayDate: "2026-06-01", PayAmt: 120, PayType: 1, PayNote: "" }
    };
    for (const [table, row] of Object.entries(samples)) {
      const payload = transformRow(table as any, row);
      expect(() => PAYLOAD_SCHEMAS[table as keyof typeof PAYLOAD_SCHEMAS].parse(payload), table).not.toThrow();
    }
  });
});
