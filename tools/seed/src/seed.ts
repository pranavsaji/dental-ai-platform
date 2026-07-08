// Seeds the simulated on-prem OpenDental MySQL databases with deterministic
// synthetic practice data: patients, schedules with gaps, claims, recalls,
// and clinical notes. Safe to re-run — drops and recreates all tables.
//
// Usage:  pnpm seed              (both sites)
//         pnpm seed -- --site a  (one site)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import mysql from "mysql2/promise";
import { faker } from "@faker-js/faker";
import * as dotenv from "dotenv";
import { D_CODES, type DCode } from "./dcodes.js";
import { clinicalNote } from "./notes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const DAY = 86_400_000;
const TX_CITIES = ["Austin", "Round Rock", "Cedar Park", "Georgetown", "Pflugerville", "Leander"];

interface SiteConfig {
  key: "a" | "b";
  url: string;
  fakerSeed: number;
  patients: number;
}

const SITES: SiteConfig[] = [
  { key: "a", url: required("OPENDENTAL_A_URL"), fakerSeed: 101, patients: 300 },
  { key: "b", url: required("OPENDENTAL_B_URL"), fakerSeed: 202, patients: 260 }
];

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (copy .env.example to .env)`);
  return v;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}
function isBusinessDay(d: Date): boolean {
  return d.getDay() !== 0 && d.getDay() !== 6;
}
function pattern(minutes: number): string {
  return "X".repeat(Math.max(2, Math.round(minutes / 5)));
}

// ---------------------------------------------------------------------------

async function seedSite(site: SiteConfig): Promise<void> {
  faker.seed(site.fakerSeed);
  const u = new URL(site.url);
  const conn = await mysql.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    multipleStatements: true
  });

  console.log(`[site ${site.key}] applying OpenDental schema...`);
  const ddl = readFileSync(path.resolve(__dirname, "../sql/opendental_schema.sql"), "utf8");
  const tables = [
    "commlog", "recall", "claimproc", "claim", "patplan", "insplan",
    "procedurelog", "appointment", "patient", "procedurecode", "operatory", "provider"
  ];
  await conn.query(tables.map((t) => `DROP TABLE IF EXISTS ${t};`).join("\n"));
  await conn.query(ddl);

  // --- providers -----------------------------------------------------------
  const providers = [
    { ProvNum: 1, Abbr: "DDS1", LName: faker.person.lastName(), FName: faker.person.firstName(), Specialty: 0 },
    { ProvNum: 2, Abbr: "DDS2", LName: faker.person.lastName(), FName: faker.person.firstName(), Specialty: 0 },
    { ProvNum: 3, Abbr: "RDH1", LName: faker.person.lastName(), FName: faker.person.firstName(), Specialty: 1 },
    { ProvNum: 4, Abbr: "RDH2", LName: faker.person.lastName(), FName: faker.person.firstName(), Specialty: 1 }
  ];
  await conn.query(
    "INSERT INTO provider (ProvNum, Abbr, LName, FName, Specialty) VALUES ?",
    [providers.map((p) => [p.ProvNum, p.Abbr, p.LName, p.FName, p.Specialty])]
  );

  // --- operatories: 1-4 doctor columns, 5-6 hygiene ------------------------
  const operatories = [1, 2, 3, 4, 5, 6].map((n) => ({
    OperatoryNum: n,
    OpName: n <= 4 ? `Op ${n} - Doctor` : `Op ${n} - Hygiene`,
    Abbrev: `OP${n}`,
    hygiene: n >= 5,
    ProvDentist: n <= 2 ? 1 : n <= 4 ? 2 : n === 5 ? 3 : 4
  }));
  await conn.query(
    "INSERT INTO operatory (OperatoryNum, OpName, Abbrev, ItemOrder, ProvDentist) VALUES ?",
    [operatories.map((o) => [o.OperatoryNum, o.OpName, o.Abbrev, o.OperatoryNum, o.ProvDentist])]
  );

  // --- procedure codes ------------------------------------------------------
  const codeByProc = new Map<string, { CodeNum: number } & DCode>();
  D_CODES.forEach((c, i) => codeByProc.set(c.code, { CodeNum: i + 1, ...c }));
  await conn.query(
    "INSERT INTO procedurecode (CodeNum, ProcCode, Descript, AbbrDesc, ProcTime) VALUES ?",
    [D_CODES.map((c, i) => [i + 1, c.code, c.descript, c.abbr, pattern(c.minutes)])]
  );

  // --- insurance plans ------------------------------------------------------
  const carriers = ["Delta Dental of Texas", "MetLife", "Cigna Dental", "Aetna", "Guardian",
    "United Concordia", "Humana Dental", "Principal", "BCBS of Texas", "Sun Life"];
  await conn.query(
    "INSERT INTO insplan (PlanNum, GroupName, GroupNum, CarrierName, PlanType) VALUES ?",
    [carriers.map((c, i) => [i + 1, faker.company.name().slice(0, 45), faker.string.numeric(6), c, "p"])]
  );

  // --- patients --------------------------------------------------------------
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  interface Pat { PatNum: number; FName: string; LName: string; hasIns: boolean; planNum: number; priProv: number }
  const patients: Pat[] = [];
  const patRows: unknown[][] = [];
  const patplanRows: unknown[][] = [];
  for (let i = 1; i <= site.patients; i++) {
    const gender = faker.number.int({ min: 0, max: 1 });
    const fname = faker.person.firstName(gender === 0 ? "male" : "female");
    const lname = faker.person.lastName();
    const birth = faker.date.birthdate({ min: 5, max: 85, mode: "age" });
    const hasIns = faker.number.float() < 0.7;
    const planNum = hasIns ? faker.number.int({ min: 1, max: carriers.length }) : 0;
    const priProv = faker.number.int({ min: 1, max: 2 });
    patients.push({ PatNum: i, FName: fname, LName: lname, hasIns, planNum, priProv });
    patRows.push([
      i, lname, fname, fmtDate(birth), gender, 0,
      "", faker.phone.number({ style: "national" }),
      `${fname.toLowerCase()}.${lname.toLowerCase()}${i}@example.com`,
      faker.location.streetAddress(), faker.helpers.arrayElement(TX_CITIES), "TX",
      faker.location.zipCode("787##"), priProv,
      fmtDate(faker.date.past({ years: 8, refDate: today }))
    ]);
    if (hasIns) patplanRows.push([patplanRows.length + 1, i, planNum, 1, faker.string.numeric(9)]);
  }
  await conn.query(
    `INSERT INTO patient (PatNum, LName, FName, Birthdate, Gender, PatStatus, HmPhone,
      WirelessPhone, Email, Address, City, State, Zip, PriProv, SecDateEntry) VALUES ?`,
    [patRows]
  );
  await conn.query(
    "INSERT INTO patplan (PatPlanNum, PatNum, PlanNum, Ordinal, SubscriberID) VALUES ?",
    [patplanRows]
  );

  // --- history: completed appointments + procedures + notes + claims ---------
  const apptRows: unknown[][] = [];
  const procRows: unknown[][] = [];
  const commRows: unknown[][] = [];
  const claimRows: unknown[][] = [];
  const claimProcRows: unknown[][] = [];
  const recallRows: unknown[][] = [];
  let aptNum = 0, procNum = 0, commNum = 0, claimNum = 0, claimProcNum = 0;
  const lastHygieneVisit = new Map<number, Date>();

  for (const pat of patients) {
    const visits = faker.number.int({ min: 1, max: 5 });
    for (let v = 0; v < visits; v++) {
      const daysAgo = faker.number.int({ min: 7, max: 540 });
      const visitDate = addDays(today, -daysAgo);
      if (!isBusinessDay(visitDate)) continue;
      visitDate.setHours(faker.number.int({ min: 8, max: 16 }), faker.helpers.arrayElement([0, 30]), 0, 0);

      const isHygiene = faker.number.float() < 0.6;
      const mainCode = isHygiene
        ? codeByProc.get(faker.helpers.arrayElement(["D1110", "D1110", "D4910", "D4341"]))!
        : codeByProc.get(faker.helpers.arrayElement(
            ["D2391", "D2392", "D2740", "D3330", "D7140", "D0150", "D9110", "D2330"]))!;
      const provNum = isHygiene ? faker.number.int({ min: 3, max: 4 }) : pat.priProv;
      const op = isHygiene ? faker.number.int({ min: 5, max: 6 }) : faker.number.int({ min: 1, max: 4 });

      aptNum++;
      apptRows.push([
        aptNum, pat.PatNum, 2, pattern(mainCode.minutes), 2, op, provNum,
        fmtDateTime(visitDate), "", mainCode.abbr
      ]);
      if (isHygiene) {
        const prev = lastHygieneVisit.get(pat.PatNum);
        if (!prev || visitDate > prev) lastHygieneVisit.set(pat.PatNum, visitDate);
      }

      // procedures on this visit (main + exam/xray add-ons for hygiene)
      const visitCodes: (typeof mainCode)[] = [mainCode];
      if (isHygiene && faker.number.float() < 0.7) visitCodes.push(codeByProc.get("D0120")!);
      if (isHygiene && faker.number.float() < 0.4) visitCodes.push(codeByProc.get("D0274")!);
      let visitFee = 0;
      const visitProcNums: number[] = [];
      for (const c of visitCodes) {
        procNum++;
        const tooth = ["D2140", "D2330", "D2391", "D2392", "D2740", "D2750", "D3310", "D3330", "D7140", "D7210"]
          .includes(c.code) ? String(faker.number.int({ min: 2, max: 31 })) : "";
        const fee = Math.round(c.fee * faker.number.float({ min: 0.95, max: 1.1 }));
        visitFee += fee;
        visitProcNums.push(procNum);
        procRows.push([procNum, pat.PatNum, aptNum, fmtDate(visitDate), fee, 2, provNum, c.CodeNum, tooth, ""]);
        if (c === mainCode) {
          commNum++;
          commRows.push([
            commNum, pat.PatNum, fmtDateTime(visitDate), 3,
            clinicalNote(c.code, tooth, providers[provNum - 1].Abbr), 4, 0
          ]);
        }
      }

      // claim for insured patients, recent visits
      if (pat.hasIns && daysAgo < 180 && faker.number.float() < 0.6) {
        claimNum++;
        const received = faker.number.float() < 0.55;
        const est = Math.round(visitFee * 0.6);
        claimRows.push([
          claimNum, pat.PatNum, fmtDate(visitDate), fmtDate(addDays(visitDate, 2)),
          received ? "R" : "S", visitFee, est, received ? Math.round(est * faker.number.float({ min: 0.8, max: 1 })) : 0,
          pat.planNum, provNum, ""
        ]);
        for (const pn of visitProcNums) {
          claimProcNum++;
          claimProcRows.push([claimProcNum, claimNum, pn, pat.PatNum, pat.planNum,
            received ? 1 : 0, visitFee, est, received ? est : 0, Math.round(visitFee * 0.15)]);
        }
      }
    }

    // recall: 6-month hygiene interval; ~overdue when last visit > 6mo ago
    const last = lastHygieneVisit.get(pat.PatNum) ?? addDays(today, -faker.number.int({ min: 200, max: 400 }));
    const due = addDays(last, 182);
    recallRows.push([pat.PatNum, pat.PatNum, fmtDate(due), fmtDate(due), fmtDate(last), 393217, 0]);
  }

  // --- upcoming schedule: next 15 business days, ~75% filled ------------------
  const upcomingByPat = new Set<number>();
  const slotTimes = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
    "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"];
  let day = new Date(today);
  let businessDays = 0;
  while (businessDays < 15) {
    day = addDays(day, 1);
    if (!isBusinessDay(day)) continue;
    businessDays++;
    for (const op of operatories) {
      let slotIdx = 0;
      while (slotIdx < slotTimes.length) {
        if (faker.number.float() > 0.75) { slotIdx++; continue; }  // the gaps agents will fill
        const code = op.hygiene
          ? codeByProc.get(faker.helpers.arrayElement(["D1110", "D1110", "D1110", "D4910"]))!
          : codeByProc.get(faker.helpers.arrayElement(["D2391", "D2392", "D2740", "D0150", "D3330", "D7140"]))!;
        const span = Math.max(1, Math.round(code.minutes / 30));
        const pat = faker.helpers.arrayElement(patients);
        const [h, m] = slotTimes[slotIdx].split(":").map(Number);
        const when = new Date(day);
        when.setHours(h, m, 0, 0);
        aptNum++;
        apptRows.push([
          aptNum, pat.PatNum, 1, pattern(code.minutes), faker.number.float() < 0.5 ? 21 : 2,
          op.OperatoryNum, op.hygiene ? op.ProvDentist : pat.priProv,
          fmtDateTime(when), "", code.abbr
        ]);
        upcomingByPat.add(pat.PatNum);
        slotIdx += span;
      }
    }
  }

  // a few recently-broken appointments (history for the dashboard)
  for (let i = 0; i < 6; i++) {
    const pat = faker.helpers.arrayElement(patients);
    const when = addDays(today, -faker.number.int({ min: 1, max: 5 }));
    if (!isBusinessDay(when)) continue;
    when.setHours(faker.number.int({ min: 8, max: 16 }), 0, 0, 0);
    aptNum++;
    apptRows.push([aptNum, pat.PatNum, 5, pattern(60), 0, faker.number.int({ min: 1, max: 6 }),
      pat.priProv, fmtDateTime(when), "Pt called to cancel", "Broken appt"]);
  }

  console.log(`[site ${site.key}] inserting ${patRows.length} patients, ${apptRows.length} appointments, ` +
    `${procRows.length} procedures, ${claimRows.length} claims, ${commRows.length} notes...`);

  await conn.query(
    `INSERT INTO appointment (AptNum, PatNum, AptStatus, Pattern, Confirmed, Op, ProvNum,
      AptDateTime, Note, ProcDescript) VALUES ?`, [apptRows]);
  await conn.query(
    `INSERT INTO procedurelog (ProcNum, PatNum, AptNum, ProcDate, ProcFee, ProcStatus,
      ProvNum, CodeNum, ToothNum, Surf) VALUES ?`, [procRows]);
  await conn.query(
    "INSERT INTO commlog (CommlogNum, PatNum, CommDateTime, CommType, Note, Mode_, SentOrReceived) VALUES ?",
    [commRows]);
  if (claimRows.length) {
    await conn.query(
      `INSERT INTO claim (ClaimNum, PatNum, DateService, DateSent, ClaimStatus, ClaimFee,
        InsPayEst, InsPayAmt, PlanNum, ProvTreat, ClaimNote) VALUES ?`, [claimRows]);
    await conn.query(
      `INSERT INTO claimproc (ClaimProcNum, ClaimNum, ProcNum, PatNum, PlanNum, Status,
        FeeBilled, InsPayEst, InsPayAmt, WriteOff) VALUES ?`, [claimProcRows]);
  }
  await conn.query(
    "INSERT INTO recall (RecallNum, PatNum, DateDue, DateDueCalc, DatePrevious, RecallInterval, RecallStatus) VALUES ?",
    [recallRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], r[6]])]);

  const [[counts]] = await conn.query<any[]>(
    `SELECT (SELECT COUNT(*) FROM patient) AS patients,
            (SELECT COUNT(*) FROM appointment WHERE AptStatus=1 AND AptDateTime > NOW()) AS upcoming,
            (SELECT COUNT(*) FROM recall WHERE DateDue < CURDATE()) AS overdueRecalls,
            (SELECT COUNT(*) FROM claim WHERE ClaimStatus='S') AS openClaims`) as any;
  console.log(`[site ${site.key}] done:`, counts);
  await conn.end();
}

// ---------------------------------------------------------------------------

const siteArg = process.argv.includes("--site")
  ? process.argv[process.argv.indexOf("--site") + 1]
  : undefined;

const targets = SITES.filter((s) => !siteArg || s.key === siteArg);
if (targets.length === 0) throw new Error(`Unknown site '${siteArg}' (use a or b)`);

for (const site of targets) {
  await seedSite(site);
}
console.log("Seeding complete.");
