// PracticeOps: the primitive mutations/queries the event generators need,
// implemented twice — over the in-memory practice (MockAdapter / pure-mock
// mode) and over the sim MySQL databases (DB mode). Generators contain the
// behavioral realism; ops contain the backend mechanics.

import type mysql from "mysql2/promise";
import { InMemoryPractice } from "./practice.js";
import { SIM_CODES } from "./model.js";

export interface SimCode {
  codeNum: number;
  code: string;
  abbr: string;
  descript: string;
  fee: number;
  minutes: number;
  hygiene: boolean;
}

export interface AppointmentLite {
  aptNum: number;
  patNum: number;
  startsAt: string; // "YYYY-MM-DD HH:MM:SS"
  provNum: number;
  op: number;
}

export interface PatientLite {
  patNum: number;
  firstName: string;
  planNum: number; // 0 = uninsured
}

export interface PracticeOps {
  now(): Date;
  codes(): SimCode[];
  listScheduled(fromDays: number, toDays: number): Promise<AppointmentLite[]>;
  breakAppointment(aptNum: number, note: string): Promise<void>;
  listPatients(): Promise<PatientLite[]>;
  bookAppointment(a: {
    patNum: number; provNum: number; op: number; startsAt: string;
    minutes: number; procDescript: string; note: string;
  }): Promise<number>;
  /** Walk-in: completed appointment + procedurelog + clinical note, now. */
  completeVisit(v: { patNum: number; provNum: number; op: number; code: SimCode }): Promise<number>;
  /** Completed procedures from the last N days with no claim yet (insured patients only). */
  unclaimedCompletedProcs(days: number): Promise<Array<{
    procNum: number; patNum: number; provNum: number; fee: number; procDate: string; planNum: number;
  }>>;
  submitClaim(c: {
    patNum: number; procNum: number; provNum: number; planNum: number; fee: number; dateService: string;
  }): Promise<number>;
  agingClaims(limit: number): Promise<Array<{ claimNum: number; patNum: number; fee: number }>>;
  denyClaim(claimNum: number, carcCodes: string, note: string): Promise<void>;
  editPatientContact(patNum: number, patch: { wirelessPhone?: string; email?: string }): Promise<void>;
  recordPayment(p: { patNum: number; amount: number; payType: number; note: string; date: string }): Promise<number>;
  /** Treatment-plan a procedure today (no appointment) — primes pre-auth (B3). */
  planProcedure(p: { patNum: number; provNum: number; code: SimCode; toothNum: string }): Promise<number>;
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}
function pattern(minutes: number): string {
  return "X".repeat(Math.max(2, Math.round(minutes / 5)));
}

const CODES: SimCode[] = SIM_CODES.map((c, i) => ({
  codeNum: i + 1, code: c.code, abbr: c.abbr, descript: c.descript,
  fee: c.fee, minutes: c.minutes, hygiene: c.hygiene
}));

// --- in-memory backend -------------------------------------------------------

export class InMemoryOps implements PracticeOps {
  constructor(private practice: InMemoryPractice) {}

  now(): Date {
    return this.practice.now();
  }

  codes(): SimCode[] {
    return CODES;
  }

  async listScheduled(fromDays: number, toDays: number): Promise<AppointmentLite[]> {
    const now = this.now();
    const from = new Date(now.getTime() + fromDays * 86_400_000);
    const to = new Date(now.getTime() + toDays * 86_400_000);
    return this.practice.rows("appointment")
      .filter((a) => Number(a.AptStatus) === 1)
      .filter((a) => {
        const t = new Date(String(a.AptDateTime).replace(" ", "T"));
        return t >= from && t <= to;
      })
      .map((a) => ({
        aptNum: Number(a.AptNum), patNum: Number(a.PatNum),
        startsAt: String(a.AptDateTime), provNum: Number(a.ProvNum), op: Number(a.Op)
      }));
  }

  async breakAppointment(aptNum: number, note: string): Promise<void> {
    this.practice.update("appointment", aptNum, { AptStatus: 5, Note: note });
  }

  async listPatients(): Promise<PatientLite[]> {
    const planByPat = new Map<number, number>();
    for (const pp of this.practice.rows("patplan")) planByPat.set(Number(pp.PatNum), Number(pp.PlanNum));
    return this.practice.rows("patient")
      .filter((p) => Number(p.PatStatus) === 0)
      .map((p) => ({
        patNum: Number(p.PatNum), firstName: String(p.FName),
        planNum: planByPat.get(Number(p.PatNum)) ?? 0
      }));
  }

  async bookAppointment(a: {
    patNum: number; provNum: number; op: number; startsAt: string;
    minutes: number; procDescript: string; note: string;
  }): Promise<number> {
    return this.practice.insert("appointment", {
      PatNum: a.patNum, AptStatus: 1, Pattern: pattern(a.minutes), Confirmed: 0,
      Op: a.op, ProvNum: a.provNum, AptDateTime: a.startsAt,
      Note: a.note, ProcDescript: a.procDescript
    });
  }

  async completeVisit(v: { patNum: number; provNum: number; op: number; code: SimCode }): Promise<number> {
    const now = this.now();
    const aptNum = this.practice.insert("appointment", {
      PatNum: v.patNum, AptStatus: 2, Pattern: pattern(v.code.minutes), Confirmed: 2,
      Op: v.op, ProvNum: v.provNum, AptDateTime: fmtDateTime(now),
      Note: "Walk-in", ProcDescript: v.code.abbr
    });
    this.practice.insert("procedurelog", {
      PatNum: v.patNum, AptNum: aptNum, ProcDate: fmtDate(now), ProcFee: v.code.fee,
      ProcStatus: 2, ProvNum: v.provNum, CodeNum: v.code.codeNum, ToothNum: "", Surf: ""
    });
    this.practice.insert("commlog", {
      PatNum: v.patNum, CommDateTime: fmtDateTime(now), CommType: 3,
      Note: `${v.code.descript} completed (walk-in). Provider ${v.provNum}.`,
      Mode_: 4, SentOrReceived: 0
    });
    return aptNum;
  }

  async unclaimedCompletedProcs(days: number) {
    const cutoff = fmtDate(new Date(this.now().getTime() - days * 86_400_000));
    const claimed = new Set(this.practice.rows("claimproc").map((cp) => Number(cp.ProcNum)));
    const planByPat = new Map<number, number>();
    for (const pp of this.practice.rows("patplan")) planByPat.set(Number(pp.PatNum), Number(pp.PlanNum));
    return this.practice.rows("procedurelog")
      .filter((p) => Number(p.ProcStatus) === 2 && String(p.ProcDate) >= cutoff && !claimed.has(Number(p.ProcNum)))
      .filter((p) => (planByPat.get(Number(p.PatNum)) ?? 0) > 0)
      .map((p) => ({
        procNum: Number(p.ProcNum), patNum: Number(p.PatNum), provNum: Number(p.ProvNum),
        fee: Number(p.ProcFee), procDate: String(p.ProcDate),
        planNum: planByPat.get(Number(p.PatNum))!
      }));
  }

  async submitClaim(c: {
    patNum: number; procNum: number; provNum: number; planNum: number; fee: number; dateService: string;
  }): Promise<number> {
    const claimNum = this.practice.insert("claim", {
      PatNum: c.patNum, DateService: c.dateService, DateSent: fmtDate(this.now()),
      ClaimStatus: "S", ClaimFee: c.fee, InsPayEst: Math.round(c.fee * 0.6), InsPayAmt: 0,
      PlanNum: c.planNum, ProvTreat: c.provNum, ClaimNote: "", CarcCodes: ""
    });
    this.practice.insert("claimproc", {
      ClaimNum: claimNum, ProcNum: c.procNum, PatNum: c.patNum, PlanNum: c.planNum,
      Status: 0, FeeBilled: c.fee, InsPayEst: Math.round(c.fee * 0.6), InsPayAmt: 0, WriteOff: 0
    });
    return claimNum;
  }

  async agingClaims(limit: number) {
    return this.practice.rows("claim")
      .filter((c) => c.ClaimStatus === "S")
      .slice(0, limit)
      .map((c) => ({ claimNum: Number(c.ClaimNum), patNum: Number(c.PatNum), fee: Number(c.ClaimFee) }));
  }

  async denyClaim(claimNum: number, carcCodes: string, note: string): Promise<void> {
    this.practice.update("claim", claimNum, {
      ClaimStatus: "R", InsPayAmt: 0, CarcCodes: carcCodes, ClaimNote: note
    });
  }

  async editPatientContact(patNum: number, patch: { wirelessPhone?: string; email?: string }): Promise<void> {
    const update: Record<string, string> = {};
    if (patch.wirelessPhone != null) update.WirelessPhone = patch.wirelessPhone;
    if (patch.email != null) update.Email = patch.email;
    this.practice.update("patient", patNum, update);
  }

  async recordPayment(p: { patNum: number; amount: number; payType: number; note: string; date: string }): Promise<number> {
    return this.practice.insert("payment", {
      PatNum: p.patNum, PayDate: p.date, PayAmt: p.amount, PayType: p.payType, PayNote: p.note
    });
  }

  async planProcedure(p: { patNum: number; provNum: number; code: SimCode; toothNum: string }): Promise<number> {
    const now = this.now();
    this.practice.insert("commlog", {
      PatNum: p.patNum, CommDateTime: fmtDateTime(now), CommType: 3,
      Note: `Treatment planned: ${p.code.descript}${p.toothNum ? ` tooth ${p.toothNum}` : ""}. Discussed findings and fees with patient.`,
      Mode_: 4, SentOrReceived: 0
    });
    return this.practice.insert("procedurelog", {
      PatNum: p.patNum, AptNum: 0, ProcDate: fmtDate(now), ProcFee: p.code.fee,
      ProcStatus: 1, ProvNum: p.provNum, CodeNum: p.code.codeNum, ToothNum: p.toothNum, Surf: ""
    });
  }
}

// --- MySQL backend -----------------------------------------------------------

export class MySqlOps implements PracticeOps {
  // ProcCode -> CodeNum as actually seeded in this database. The seeder's
  // procedurecode table (D_CODES) is a superset of SIM_CODES in a different
  // order, so the in-memory index+1 convention does NOT hold in DB mode —
  // inserts must translate through this map or they write the wrong code.
  private codeNumByProcCode: Map<string, number> | null = null;

  constructor(private pool: mysql.Pool) {}

  now(): Date {
    return new Date();
  }

  codes(): SimCode[] {
    return CODES;
  }

  private async dbCodeNum(procCode: string): Promise<number> {
    if (!this.codeNumByProcCode) {
      const [rows] = await this.pool.query<any[]>("SELECT CodeNum, ProcCode FROM procedurecode");
      this.codeNumByProcCode = new Map(rows.map((r) => [String(r.ProcCode), Number(r.CodeNum)]));
    }
    const num = this.codeNumByProcCode.get(procCode);
    if (!num) throw new Error(`procedure code ${procCode} not found in sim database`);
    return num;
  }

  async listScheduled(fromDays: number, toDays: number): Promise<AppointmentLite[]> {
    const [rows] = await this.pool.query<any[]>(
      `SELECT AptNum, PatNum, AptDateTime, ProvNum, Op FROM appointment
       WHERE AptStatus = 1
         AND AptDateTime >= DATE_ADD(NOW(), INTERVAL ? DAY)
         AND AptDateTime <= DATE_ADD(NOW(), INTERVAL ? DAY)`,
      [fromDays, toDays]
    );
    return rows.map((r) => ({
      aptNum: Number(r.AptNum), patNum: Number(r.PatNum),
      startsAt: String(r.AptDateTime), provNum: Number(r.ProvNum), op: Number(r.Op)
    }));
  }

  async breakAppointment(aptNum: number, note: string): Promise<void> {
    await this.pool.execute("UPDATE appointment SET AptStatus = 5, Note = ? WHERE AptNum = ?", [note, aptNum]);
  }

  async listPatients(): Promise<PatientLite[]> {
    const [rows] = await this.pool.query<any[]>(
      `SELECT p.PatNum, p.FName, COALESCE(pp.PlanNum, 0) AS PlanNum
       FROM patient p LEFT JOIN patplan pp ON pp.PatNum = p.PatNum
       WHERE p.PatStatus = 0`
    );
    return rows.map((r) => ({ patNum: Number(r.PatNum), firstName: String(r.FName), planNum: Number(r.PlanNum) }));
  }

  async bookAppointment(a: {
    patNum: number; provNum: number; op: number; startsAt: string;
    minutes: number; procDescript: string; note: string;
  }): Promise<number> {
    const [res] = await this.pool.execute<any>(
      `INSERT INTO appointment (PatNum, AptStatus, Pattern, Confirmed, Op, ProvNum, AptDateTime, Note, ProcDescript)
       VALUES (?, 1, ?, 0, ?, ?, ?, ?, ?)`,
      [a.patNum, pattern(a.minutes), a.op, a.provNum, a.startsAt, a.note, a.procDescript]
    );
    return res.insertId;
  }

  async completeVisit(v: { patNum: number; provNum: number; op: number; code: SimCode }): Promise<number> {
    const [apt] = await this.pool.execute<any>(
      `INSERT INTO appointment (PatNum, AptStatus, Pattern, Confirmed, Op, ProvNum, AptDateTime, Note, ProcDescript)
       VALUES (?, 2, ?, 2, ?, ?, NOW(), 'Walk-in', ?)`,
      [v.patNum, pattern(v.code.minutes), v.op, v.provNum, v.code.abbr]
    );
    await this.pool.execute(
      `INSERT INTO procedurelog (PatNum, AptNum, ProcDate, ProcFee, ProcStatus, ProvNum, CodeNum, ToothNum, Surf)
       VALUES (?, ?, CURDATE(), ?, 2, ?, ?, '', '')`,
      [v.patNum, apt.insertId, v.code.fee, v.provNum, await this.dbCodeNum(v.code.code)]
    );
    await this.pool.execute(
      `INSERT INTO commlog (PatNum, CommDateTime, CommType, Note, Mode_, SentOrReceived)
       VALUES (?, NOW(), 3, ?, 4, 0)`,
      [v.patNum, `${v.code.descript} completed (walk-in). Provider ${v.provNum}.`]
    );
    return apt.insertId;
  }

  async unclaimedCompletedProcs(days: number) {
    const [rows] = await this.pool.query<any[]>(
      `SELECT pl.ProcNum, pl.PatNum, pl.ProvNum, pl.ProcFee, pl.ProcDate, pp.PlanNum
       FROM procedurelog pl
       INNER JOIN patplan pp ON pp.PatNum = pl.PatNum
       LEFT JOIN claimproc cp ON cp.ProcNum = pl.ProcNum
       WHERE pl.ProcStatus = 2 AND pl.ProcDate >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
         AND cp.ClaimProcNum IS NULL
       LIMIT 50`,
      [days]
    );
    return rows.map((r) => ({
      procNum: Number(r.ProcNum), patNum: Number(r.PatNum), provNum: Number(r.ProvNum),
      fee: Number(r.ProcFee), procDate: String(r.ProcDate).slice(0, 10), planNum: Number(r.PlanNum)
    }));
  }

  async submitClaim(c: {
    patNum: number; procNum: number; provNum: number; planNum: number; fee: number; dateService: string;
  }): Promise<number> {
    const est = Math.round(c.fee * 0.6);
    const [res] = await this.pool.execute<any>(
      `INSERT INTO claim (PatNum, DateService, DateSent, ClaimStatus, ClaimFee, InsPayEst, InsPayAmt, PlanNum, ProvTreat, ClaimNote, CarcCodes)
       VALUES (?, ?, CURDATE(), 'S', ?, ?, 0, ?, ?, '', '')`,
      [c.patNum, c.dateService, c.fee, est, c.planNum, c.provNum]
    );
    await this.pool.execute(
      `INSERT INTO claimproc (ClaimNum, ProcNum, PatNum, PlanNum, Status, FeeBilled, InsPayEst, InsPayAmt, WriteOff)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0)`,
      [res.insertId, c.procNum, c.patNum, c.planNum, c.fee, est]
    );
    return res.insertId;
  }

  async agingClaims(limit: number) {
    const [rows] = await this.pool.query<any[]>(
      `SELECT ClaimNum, PatNum, ClaimFee FROM claim WHERE ClaimStatus = 'S'
       ORDER BY DateSent ASC LIMIT ${Number(limit)}`
    );
    return rows.map((r) => ({ claimNum: Number(r.ClaimNum), patNum: Number(r.PatNum), fee: Number(r.ClaimFee) }));
  }

  async denyClaim(claimNum: number, carcCodes: string, note: string): Promise<void> {
    await this.pool.execute(
      "UPDATE claim SET ClaimStatus = 'R', InsPayAmt = 0, CarcCodes = ?, ClaimNote = ? WHERE ClaimNum = ?",
      [carcCodes, note, claimNum]
    );
  }

  async editPatientContact(patNum: number, patch: { wirelessPhone?: string; email?: string }): Promise<void> {
    if (patch.wirelessPhone != null) {
      await this.pool.execute("UPDATE patient SET WirelessPhone = ? WHERE PatNum = ?", [patch.wirelessPhone, patNum]);
    }
    if (patch.email != null) {
      await this.pool.execute("UPDATE patient SET Email = ? WHERE PatNum = ?", [patch.email, patNum]);
    }
  }

  async recordPayment(p: { patNum: number; amount: number; payType: number; note: string; date: string }): Promise<number> {
    const [res] = await this.pool.execute<any>(
      "INSERT INTO payment (PatNum, PayDate, PayAmt, PayType, PayNote) VALUES (?, ?, ?, ?, ?)",
      [p.patNum, p.date, p.amount, p.payType, p.note]
    );
    return res.insertId;
  }

  async planProcedure(p: { patNum: number; provNum: number; code: SimCode; toothNum: string }): Promise<number> {
    await this.pool.execute(
      `INSERT INTO commlog (PatNum, CommDateTime, CommType, Note, Mode_, SentOrReceived)
       VALUES (?, NOW(), 3, ?, 4, 0)`,
      [p.patNum, `Treatment planned: ${p.code.descript}${p.toothNum ? ` tooth ${p.toothNum}` : ""}. Discussed findings and fees with patient.`]
    );
    const [res] = await this.pool.execute<any>(
      `INSERT INTO procedurelog (PatNum, AptNum, ProcDate, ProcFee, ProcStatus, ProvNum, CodeNum, ToothNum, Surf)
       VALUES (?, 0, CURDATE(), ?, 1, ?, ?, ?, '')`,
      [p.patNum, p.code.fee, p.provNum, await this.dbCodeNum(p.code.code), p.toothNum]
    );
    return res.insertId;
  }
}
