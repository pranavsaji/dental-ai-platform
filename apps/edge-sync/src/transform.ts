import type { SyncTable } from "@dental/shared";

// Maps raw OpenDental rows (dateStrings: true, so all temporal columns arrive
// as strings) into the canonical payloads defined in @dental/shared. This is the
// PMS-specific boundary: nothing north of here knows OpenDental column names.

const NULL_DATE = "0001-01-01";

function dateOrNull(v: string | null): string | null {
  if (!v || v.startsWith(NULL_DATE) || v.startsWith("0000")) return null;
  return v.slice(0, 10);
}

function toIso(dt: string): string {
  // "2026-07-06 14:30:00" -> "2026-07-06T14:30:00" (practice-local, no TZ)
  return dt.replace(" ", "T");
}

const GENDERS = ["male", "female", "unknown"] as const;
const APT_STATUS: Record<number, string> = {
  1: "scheduled", 2: "complete", 3: "unscheduled", 5: "broken", 6: "planned"
};
const PROC_STATUS: Record<number, string> = { 1: "planned", 2: "complete", 6: "deleted" };
const CLAIM_STATUS: Record<string, string> = {
  U: "unsent", H: "hold", W: "waiting", S: "sent", R: "received"
};
const PAT_STATUS: Record<number, string> = { 0: "active", 2: "inactive", 4: "archived" };

type Row = Record<string, any>;

export const TABLE_META: Record<SyncTable, { pk: string; stampCol: string }> = {
  provider: { pk: "ProvNum", stampCol: "DateTStamp" },
  operatory: { pk: "OperatoryNum", stampCol: "DateTStamp" },
  procedurecode: { pk: "CodeNum", stampCol: "DateTStamp" },
  patient: { pk: "PatNum", stampCol: "DateTStamp" },
  appointment: { pk: "AptNum", stampCol: "DateTStamp" },
  procedurelog: { pk: "ProcNum", stampCol: "DateTStamp" },
  insplan: { pk: "PlanNum", stampCol: "DateTStamp" },
  patplan: { pk: "PatPlanNum", stampCol: "DateTStamp" },
  claim: { pk: "ClaimNum", stampCol: "DateTStamp" },
  claimproc: { pk: "ClaimProcNum", stampCol: "DateTStamp" },
  recall: { pk: "RecallNum", stampCol: "DateTStamp" },
  commlog: { pk: "CommlogNum", stampCol: "DateTStamp" },
  payment: { pk: "PayNum", stampCol: "DateTStamp" }
};

// Reference tables first so FIFO ingest never sees an appointment before its
// patient on the initial full sync.
export const SYNC_ORDER: SyncTable[] = [
  "provider", "operatory", "procedurecode", "insplan",
  "patient", "patplan", "appointment", "procedurelog",
  "claim", "claimproc", "recall", "commlog", "payment"
];

export function transformRow(table: SyncTable, r: Row): unknown {
  switch (table) {
    case "provider":
      return {
        abbr: r.Abbr, lastName: r.LName, firstName: r.FName,
        specialty: Number(r.Specialty), isHidden: !!r.IsHidden
      };
    case "operatory":
      return {
        name: r.OpName, abbrev: r.Abbrev, itemOrder: Number(r.ItemOrder),
        defaultProviderId: Number(r.ProvDentist), isHidden: !!r.IsHidden
      };
    case "procedurecode":
      return { procCode: r.ProcCode, description: r.Descript, abbrDesc: r.AbbrDesc };
    case "patient":
      return {
        lastName: r.LName, firstName: r.FName,
        birthdate: dateOrNull(r.Birthdate),
        gender: GENDERS[Number(r.Gender)] ?? "unknown",
        status: PAT_STATUS[Number(r.PatStatus)] ?? "inactive",
        homePhone: r.HmPhone, wirelessPhone: r.WirelessPhone, email: r.Email,
        address: r.Address, city: r.City, state: r.State, zip: r.Zip,
        primaryProviderId: Number(r.PriProv),
        firstVisit: dateOrNull(r.SecDateEntry),
        smsConsent: Number(r.TxtMsgOk ?? 0) !== 2 // OD: 0 unknown, 1 yes, 2 no
      };
    case "appointment":
      return {
        patientId: Number(r.PatNum),
        status: APT_STATUS[Number(r.AptStatus)] ?? "unscheduled",
        startsAt: toIso(r.AptDateTime),
        minutes: Math.max(10, String(r.Pattern ?? "").length * 5),
        confirmed: Number(r.Confirmed) > 1, // OD: >1 means a confirmation status is set
        operatoryId: Number(r.Op), providerId: Number(r.ProvNum),
        note: r.Note ?? "", procDescript: r.ProcDescript ?? ""
      };
    case "procedurelog":
      return {
        patientId: Number(r.PatNum), appointmentId: Number(r.AptNum),
        procDate: dateOrNull(r.ProcDate), fee: Number(r.ProcFee),
        status: PROC_STATUS[Number(r.ProcStatus)] ?? "other",
        providerId: Number(r.ProvNum), codeId: Number(r.CodeNum),
        toothNum: r.ToothNum ?? "", surface: r.Surf ?? ""
      };
    case "insplan":
      return {
        groupName: r.GroupName, groupNum: r.GroupNum,
        carrierName: r.CarrierName, planType: r.PlanType,
        carrierPhone: r.CarrierPhone ?? "", payerId: r.ElectID ?? "",
        annualMax: Number(r.AnnualMax ?? 0), deductible: Number(r.Deductible ?? 0)
      };
    case "patplan":
      return {
        patientId: Number(r.PatNum), planId: Number(r.PlanNum),
        ordinal: Number(r.Ordinal), subscriberId: r.SubscriberID
      };
    case "claim":
      return {
        patientId: Number(r.PatNum),
        dateService: dateOrNull(r.DateService), dateSent: dateOrNull(r.DateSent),
        status: CLAIM_STATUS[r.ClaimStatus] ?? "unsent",
        claimFee: Number(r.ClaimFee), insPayEst: Number(r.InsPayEst),
        insPayAmt: Number(r.InsPayAmt), planId: Number(r.PlanNum),
        providerId: Number(r.ProvTreat), note: r.ClaimNote ?? "",
        carcCodes: r.CarcCodes ?? ""
      };
    case "claimproc":
      return {
        claimId: Number(r.ClaimNum), procedureId: Number(r.ProcNum),
        patientId: Number(r.PatNum), planId: Number(r.PlanNum),
        received: Number(r.Status) === 1,
        feeBilled: Number(r.FeeBilled), insPayEst: Number(r.InsPayEst),
        insPayAmt: Number(r.InsPayAmt), writeOff: Number(r.WriteOff)
      };
    case "recall":
      return {
        patientId: Number(r.PatNum),
        dateDue: dateOrNull(r.DateDue), datePrevious: dateOrNull(r.DatePrevious),
        isDisabled: !!r.IsDisabled
      };
    case "commlog":
      return {
        patientId: Number(r.PatNum), happenedAt: toIso(r.CommDateTime),
        commType: Number(r.CommType), note: r.Note ?? "",
        mode: Number(r.Mode_), sentOrReceived: Number(r.SentOrReceived)
      };
    case "payment":
      return {
        patientId: Number(r.PatNum), payDate: dateOrNull(r.PayDate),
        amount: Number(r.PayAmt), payType: Number(r.PayType),
        note: r.PayNote ?? ""
      };
  }
}
