// Builds a deterministic in-memory practice: the data the MockAdapter serves
// when there is no PMS at all (PMS_MODE=mock). Smaller than the MySQL seed but
// shaped identically — every dashboard page and workflow has material.

import { CARRIER_RULES } from "@dental/shared";
import { createRng, type Rng } from "./rng.js";
import { InMemoryPractice, fmtStamp } from "./practice.js";

const DAY = 86_400_000;

// Compact CDT code set (mirrors tools/seed/src/dcodes.ts entries the
// generators actually use).
export const SIM_CODES = [
  { code: "D0120", descript: "Periodic oral evaluation - established patient", abbr: "PerEx", fee: 65, minutes: 10, hygiene: false },
  { code: "D0150", descript: "Comprehensive oral evaluation - new or established patient", abbr: "CompEx", fee: 110, minutes: 30, hygiene: false },
  { code: "D0274", descript: "Bitewings - four radiographic images", abbr: "4BW", fee: 75, minutes: 10, hygiene: true },
  { code: "D1110", descript: "Prophylaxis - adult", abbr: "ProphyAd", fee: 115, minutes: 40, hygiene: true },
  { code: "D2391", descript: "Resin-based composite - one surface, posterior", abbr: "Comp1P", fee: 210, minutes: 30, hygiene: false },
  { code: "D2392", descript: "Resin-based composite - two surfaces, posterior", abbr: "Comp2P", fee: 265, minutes: 40, hygiene: false },
  { code: "D2740", descript: "Crown - porcelain/ceramic", abbr: "CrownPC", fee: 1350, minutes: 90, hygiene: false },
  { code: "D2950", descript: "Core buildup, including any pins when required", abbr: "Buildup", fee: 320, minutes: 30, hygiene: false },
  { code: "D3330", descript: "Endodontic therapy, molar tooth", abbr: "RCT-Mol", fee: 1400, minutes: 120, hygiene: false },
  { code: "D4341", descript: "Periodontal scaling and root planing - four or more teeth per quadrant", abbr: "SRP4+", fee: 285, minutes: 60, hygiene: true },
  { code: "D4910", descript: "Periodontal maintenance", abbr: "PerioMaint", fee: 160, minutes: 50, hygiene: true },
  { code: "D7140", descript: "Extraction, erupted tooth or exposed root", abbr: "Ext", fee: 240, minutes: 30, hygiene: false },
  { code: "D9110", descript: "Palliative treatment of dental pain", abbr: "Palliative", fee: 120, minutes: 20, hygiene: false },
  { code: "D9944", descript: "Occlusal guard - hard appliance, full arch", abbr: "NightGuard", fee: 550, minutes: 30, hygiene: false }
] as const;

const FIRST_NAMES = [
  "James", "Maria", "Robert", "Linda", "Michael", "Elena", "David", "Susan", "Carlos", "Karen",
  "Daniel", "Nancy", "Miguel", "Lisa", "Anthony", "Sandra", "Kevin", "Ashley", "Brian", "Emily",
  "Jose", "Amanda", "Thomas", "Melissa", "Chris", "Deborah", "Mark", "Stephanie", "Steven", "Rebecca"
];
const LAST_NAMES = [
  "Garcia", "Smith", "Martinez", "Johnson", "Rodriguez", "Brown", "Hernandez", "Jones", "Lopez",
  "Miller", "Gonzalez", "Davis", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson",
  "Martin", "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis"
];

function pattern(minutes: number): string {
  return "X".repeat(Math.max(2, Math.round(minutes / 5)));
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}
function isBusinessDay(d: Date): boolean {
  return d.getDay() !== 0 && d.getDay() !== 6;
}

export interface BuildOptions {
  patients?: number;
  now?: () => Date;
}

export function buildPractice(seed: number, opts: BuildOptions = {}): InMemoryPractice {
  const rng: Rng = createRng(seed);
  const practice = new InMemoryPractice(opts.now);
  const patientCount = opts.patients ?? 60;
  const today = new Date(practice.now());
  today.setHours(0, 0, 0, 0);

  // Backdate seeded history stamps so live mutations always sort after them.
  const seededStamp = fmtStamp(addDays(today, -1));
  const stamped = (table: string, row: Record<string, any>) => {
    const id = practice.insert(table, row);
    practice.table(table).get(id)!.DateTStamp = seededStamp;
    return id;
  };

  for (let i = 1; i <= 4; i++) {
    stamped("provider", {
      Abbr: i <= 2 ? `DDS${i}` : `RDH${i - 2}`,
      LName: rng.pick(LAST_NAMES), FName: rng.pick(FIRST_NAMES),
      Specialty: i <= 2 ? 0 : 1, IsHidden: 0
    });
  }
  for (let i = 1; i <= 6; i++) {
    stamped("operatory", {
      OpName: i <= 4 ? `Op ${i} - Doctor` : `Op ${i} - Hygiene`,
      Abbrev: `OP${i}`, ItemOrder: i, IsHidden: 0,
      ProvDentist: i <= 2 ? 1 : i <= 4 ? 2 : i === 5 ? 3 : 4
    });
  }
  SIM_CODES.forEach((c) => {
    stamped("procedurecode", { ProcCode: c.code, Descript: c.descript, AbbrDesc: c.abbr, ProcTime: pattern(c.minutes) });
  });
  CARRIER_RULES.forEach((c, i) => {
    stamped("insplan", {
      GroupName: `Group ${i + 1}`, GroupNum: String(100000 + i), CarrierName: c.carrierName,
      PlanType: "p", CarrierPhone: c.carrierPhone, ElectID: c.payerId,
      AnnualMax: c.annualMax, Deductible: c.deductible
    });
  });

  const codeBy = new Map(SIM_CODES.map((c, i) => [c.code, { ...c, CodeNum: i + 1 }]));

  for (let p = 1; p <= patientCount; p++) {
    const fname = rng.pick(FIRST_NAMES);
    const lname = rng.pick(LAST_NAMES);
    const hasIns = rng.chance(0.7);
    const planNum = hasIns ? rng.int(1, CARRIER_RULES.length) : 0;
    const priProv = rng.int(1, 2);
    const birthYear = today.getFullYear() - rng.int(6, 84);
    stamped("patient", {
      LName: lname, FName: fname,
      Birthdate: `${birthYear}-${String(rng.int(1, 12)).padStart(2, "0")}-${String(rng.int(1, 28)).padStart(2, "0")}`,
      Gender: rng.int(0, 1), PatStatus: 0,
      HmPhone: rng.chance(0.3) ? `(512) 555-2${String(p).padStart(3, "0")}` : "",
      WirelessPhone: rng.chance(0.92) ? `(512) 555-0${String(p).padStart(3, "0")}` : "",
      Email: rng.chance(0.8) ? `${fname.toLowerCase()}.${lname.toLowerCase()}${p}@example.com` : "",
      Address: `${rng.int(100, 9900)} Simulated Ln`, City: "Austin", State: "TX", Zip: "78701",
      PriProv: priProv, TxtMsgOk: rng.chance(0.08) ? 2 : rng.chance(0.65) ? 1 : 0,
      SecDateEntry: fmtDate(addDays(today, -rng.int(30, 2200)))
    });
    if (hasIns) {
      stamped("patplan", { PatNum: p, PlanNum: planNum, Ordinal: 1, SubscriberID: String(rng.int(100000000, 999999999)) });
    }

    // history: 1–3 completed visits, notes, claims, payments
    let lastHygiene: Date | null = null;
    const visits = rng.int(1, 3);
    for (let v = 0; v < visits; v++) {
      const visitDate = addDays(today, -rng.int(7, 500));
      if (!isBusinessDay(visitDate)) continue;
      visitDate.setHours(rng.int(8, 16), rng.pick([0, 30]), 0, 0);
      const isHygiene = rng.chance(0.6);
      const code = isHygiene
        ? codeBy.get(rng.pick(["D1110", "D1110", "D4910", "D4341"]))!
        : codeBy.get(rng.pick(["D2391", "D2392", "D2740", "D3330", "D7140", "D0150", "D9110"]))!;
      const provNum = isHygiene ? rng.int(3, 4) : priProv;
      const aptNum = stamped("appointment", {
        PatNum: p, AptStatus: 2, Pattern: pattern(code.minutes), Confirmed: 2,
        Op: isHygiene ? rng.int(5, 6) : rng.int(1, 4), ProvNum: provNum,
        AptDateTime: `${fmtDate(visitDate)} ${String(visitDate.getHours()).padStart(2, "0")}:${String(visitDate.getMinutes()).padStart(2, "0")}:00`,
        Note: "", ProcDescript: code.abbr
      });
      if (isHygiene && (!lastHygiene || visitDate > lastHygiene)) lastHygiene = visitDate;
      const fee = Math.round(code.fee * (0.95 + rng.float() * 0.15));
      const procNum = stamped("procedurelog", {
        PatNum: p, AptNum: aptNum, ProcDate: fmtDate(visitDate), ProcFee: fee, ProcStatus: 2,
        ProvNum: provNum, CodeNum: code.CodeNum, ToothNum: "", Surf: ""
      });
      stamped("commlog", {
        PatNum: p, CommDateTime: `${fmtDate(visitDate)} ${String(visitDate.getHours()).padStart(2, "0")}:30:00`,
        CommType: 3, Note: `${code.descript} completed without complication. Provider ${provNum}.`,
        Mode_: 4, SentOrReceived: 0
      });
      let insPaid = 0;
      if (hasIns && rng.chance(0.5)) {
        const est = Math.round(fee * 0.6);
        const denied = rng.chance(0.2);
        const resolved = rng.chance(0.6);
        insPaid = resolved && !denied ? Math.round(est * (0.85 + rng.float() * 0.15)) : 0;
        const claimNum = stamped("claim", {
          PatNum: p, DateService: fmtDate(visitDate), DateSent: fmtDate(addDays(visitDate, 2)),
          ClaimStatus: resolved || denied ? "R" : "S", ClaimFee: fee, InsPayEst: est, InsPayAmt: insPaid,
          PlanNum: planNum, ProvTreat: provNum,
          ClaimNote: denied ? "Denied; see CARC" : "",
          CarcCodes: denied ? rng.pick(["16", "96", "97", "197", "45"]) : ""
        });
        stamped("claimproc", {
          ClaimNum: claimNum, ProcNum: procNum, PatNum: p, PlanNum: planNum,
          Status: resolved || denied ? 1 : 0, FeeBilled: fee, InsPayEst: est, InsPayAmt: insPaid,
          WriteOff: Math.round(fee * 0.15)
        });
        if (insPaid > 0) {
          stamped("payment", {
            PatNum: p, PayDate: fmtDate(addDays(visitDate, rng.int(14, 40))), PayAmt: insPaid,
            PayType: 4, PayNote: "Insurance EFT"
          });
        }
      }
      if (fee - insPaid > 0 && rng.chance(0.9)) {
        stamped("payment", {
          PatNum: p, PayDate: fmtDate(addDays(visitDate, rng.int(0, 45))), PayAmt: fee - insPaid,
          PayType: rng.pick([1, 2, 2, 3]), PayNote: "Patient payment"
        });
      }
    }

    // planned-but-unscheduled treatment for ~15%
    if (rng.chance(0.15)) {
      const code = codeBy.get(rng.pick(["D2740", "D4341", "D2392", "D9944", "D2950"]))!;
      stamped("procedurelog", {
        PatNum: p, AptNum: 0, ProcDate: fmtDate(addDays(today, -rng.int(21, 180))),
        ProcFee: Math.max(180, Math.min(1400, code.fee)), ProcStatus: 1, ProvNum: priProv,
        CodeNum: code.CodeNum, ToothNum: "", Surf: ""
      });
    }

    const due = lastHygiene ? addDays(lastHygiene, 182) : addDays(today, -rng.int(10, 200));
    stamped("recall", {
      PatNum: p, DateDueCalc: fmtDate(due), DateDue: fmtDate(due),
      DatePrevious: fmtDate(lastHygiene ?? addDays(due, -182)), RecallInterval: 393217,
      RecallStatus: 0, IsDisabled: 0
    });
  }

  // upcoming schedule: next 10 business days, ~70% filled; ~50% unconfirmed
  const slotTimes = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"];
  let day = new Date(today);
  let businessDays = 0;
  while (businessDays < 10) {
    day = addDays(day, 1);
    if (!isBusinessDay(day)) continue;
    businessDays++;
    for (const op of practice.rows("operatory")) {
      let slotIdx = 0;
      while (slotIdx < slotTimes.length) {
        if (rng.chance(0.3)) { slotIdx++; continue; } // the gaps agents will fill
        const hygiene = op.OperatoryNum >= 5;
        const code = hygiene
          ? codeBy.get(rng.pick(["D1110", "D1110", "D4910"]))!
          : codeBy.get(rng.pick(["D2391", "D2392", "D2740", "D0150", "D7140"]))!;
        const patNum = rng.int(1, patientCount);
        stamped("appointment", {
          PatNum: patNum, AptStatus: 1, Pattern: pattern(code.minutes),
          Confirmed: rng.chance(0.5) ? 21 : 0,
          Op: op.OperatoryNum,
          ProvNum: hygiene ? op.ProvDentist : practice.get("patient", patNum)!.PriProv,
          AptDateTime: `${fmtDate(day)} ${slotTimes[slotIdx]}:00`,
          Note: "", ProcDescript: code.abbr
        });
        slotIdx += Math.max(1, Math.round(code.minutes / 30));
      }
    }
  }

  // chronic no-show personas
  for (let n = 0; n < 2; n++) {
    const patNum = rng.int(1, patientCount);
    for (let m = 0; m < rng.int(3, 5); m++) {
      const when = addDays(today, -rng.int(10, 300));
      if (!isBusinessDay(when)) continue;
      stamped("appointment", {
        PatNum: patNum, AptStatus: 5, Pattern: pattern(40), Confirmed: 0,
        Op: rng.int(1, 6), ProvNum: rng.int(1, 2),
        AptDateTime: `${fmtDate(when)} ${String(rng.int(8, 16)).padStart(2, "0")}:00:00`,
        Note: "No-show — patient did not arrive", ProcDescript: "No-show"
      });
    }
  }

  return practice;
}
