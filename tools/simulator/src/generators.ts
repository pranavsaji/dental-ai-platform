// Event generators: each is a pure function of (rng, ops) — deterministic
// under a fixed seed, so CI can assert exact outcomes. Generators return a
// human-readable description of what happened (for the CLI narrator) or null
// when no candidate existed.

import type { Rng } from "./rng.js";
import type { PracticeOps } from "./ops.js";

export type Generator = (rng: Rng, ops: PracticeOps) => Promise<string | null>;

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isBusinessDay(d: Date): boolean {
  return d.getDay() !== 0 && d.getDay() !== 6;
}

/** Cancellation of a future appointment, weighted toward tomorrow (feeds backfill). */
export const cancellation: Generator = async (rng, ops) => {
  const upcoming = await ops.listScheduled(0, 7);
  if (upcoming.length === 0) return null;
  const tomorrow = fmtDate(new Date(ops.now().getTime() + 86_400_000));
  const weighted = upcoming.map((a) =>
    [a, a.startsAt.startsWith(tomorrow) ? 4 : 1] as const);
  const victim = rng.weighted(weighted);
  await ops.breakAppointment(victim.aptNum, "Pt called to cancel (simulator)");
  return `cancelled appointment ${victim.aptNum} at ${victim.startsAt} (patient ${victim.patNum})`;
};

/** New booking into an open slot in the next 7 days. */
export const booking: Generator = async (rng, ops) => {
  const patients = await ops.listPatients();
  if (patients.length === 0) return null;
  const codes = ops.codes().filter((c) => !c.hygiene);
  const code = rng.pick(codes);
  // Find a conflict-free slot: random business day + slot time + operatory.
  const busy = await ops.listScheduled(0, 7);
  for (let attempt = 0; attempt < 8; attempt++) {
    const day = new Date(ops.now().getTime() + rng.int(1, 7) * 86_400_000);
    if (!isBusinessDay(day)) continue;
    const hour = rng.pick([8, 9, 10, 11, 13, 14, 15, 16]);
    const minute = rng.pick([0, 30]);
    const op = rng.int(1, 4);
    const startsAt = `${fmtDate(day)} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
    if (busy.some((a) => a.op === op && a.startsAt === startsAt)) continue;
    const pat = rng.pick(patients);
    const aptNum = await ops.bookAppointment({
      patNum: pat.patNum, provNum: rng.int(1, 2), op, startsAt,
      minutes: code.minutes, procDescript: code.abbr, note: "Booked by phone (simulator)"
    });
    return `booked appointment ${aptNum} for patient ${pat.patNum} at ${startsAt} (${code.abbr})`;
  }
  return null;
};

/** Walk-in completion: appointment completed now + procedure + clinical note. */
export const walkIn: Generator = async (rng, ops) => {
  const patients = await ops.listPatients();
  if (patients.length === 0) return null;
  const pat = rng.pick(patients);
  const code = rng.pick(ops.codes().filter((c) => ["D9110", "D2391", "D0120", "D7140"].includes(c.code)));
  const aptNum = await ops.completeVisit({
    patNum: pat.patNum, provNum: rng.int(1, 2), op: rng.int(1, 4), code
  });
  return `walk-in completed: appointment ${aptNum}, patient ${pat.patNum} (${code.abbr}, $${code.fee})`;
};

/** Claim submission for a recently completed, still-unclaimed procedure. */
export const claimSubmission: Generator = async (rng, ops) => {
  const candidates = await ops.unclaimedCompletedProcs(30);
  if (candidates.length === 0) return null;
  const proc = rng.pick(candidates);
  const claimNum = await ops.submitClaim({
    patNum: proc.patNum, procNum: proc.procNum, provNum: proc.provNum,
    planNum: proc.planNum, fee: proc.fee, dateService: proc.procDate
  });
  return `submitted claim ${claimNum} for patient ${proc.patNum} ($${proc.fee})`;
};

/** Patient demographic edit — exercises sync provenance on the patient table. */
export const demographicEdit: Generator = async (rng, ops) => {
  const patients = await ops.listPatients();
  if (patients.length === 0) return null;
  const pat = rng.pick(patients);
  const newPhone = `(512) 555-${rng.int(1000, 9999)}`;
  await ops.editPatientContact(pat.patNum, { wirelessPhone: newPhone });
  return `updated patient ${pat.patNum} wireless phone to ${newPhone}`;
};

/** Occasional patient payment (feeds collections metrics, A4). */
export const payment: Generator = async (rng, ops) => {
  const patients = await ops.listPatients();
  if (patients.length === 0) return null;
  const pat = rng.pick(patients);
  const amount = rng.int(40, 400);
  const id = await ops.recordPayment({
    patNum: pat.patNum, amount, payType: rng.pick([1, 2, 2, 3]),
    note: "Patient payment (simulator)", date: fmtDate(ops.now())
  });
  return `recorded payment ${id}: $${amount} from patient ${pat.patNum}`;
};

export const GENERATORS: ReadonlyArray<readonly [Generator, number, string]> = [
  [cancellation, 25, "cancellation"],
  [booking, 25, "booking"],
  [walkIn, 15, "walk-in"],
  [claimSubmission, 15, "claim"],
  [demographicEdit, 10, "demographic-edit"],
  [payment, 10, "payment"]
];

/** One live-mode tick: weighted-random generator, returns its narration. */
export async function runTick(rng: Rng, ops: PracticeOps): Promise<string | null> {
  const gen = rng.weighted(GENERATORS.map(([g, w]) => [g, w] as const));
  return gen(rng, ops);
}
