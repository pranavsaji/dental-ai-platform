// Named, replayable event sequences — the demo scripts and E2E fixtures.
// `pnpm simulate <name>` primes exactly the state a demo needs.

import type { Rng } from "./rng.js";
import type { PracticeOps } from "./ops.js";
import { booking, cancellation, demographicEdit, payment, walkIn } from "./generators.js";

export interface Scenario {
  name: string;
  description: string;
  run(rng: Rng, ops: PracticeOps): Promise<string[]>;
}

async function collect(log: string[], result: string | null): Promise<void> {
  if (result) log.push(result);
}

export const SCENARIOS: Record<string, Scenario> = {
  "flagship-loop": {
    name: "flagship-loop",
    description: "Cancel one appointment tomorrow — primes the cancellation → approval → SMS → booking loop.",
    async run(rng, ops) {
      const log: string[] = [];
      await collect(log, await cancellation(rng, ops));
      if (log.length === 0) log.push("no future appointments to cancel — book some first (busy-morning)");
      return log;
    }
  },

  "busy-morning": {
    name: "busy-morning",
    description: "A realistic morning burst: bookings, cancellations, walk-ins, an address change, payments.",
    async run(rng, ops) {
      const log: string[] = [];
      for (let i = 0; i < 3; i++) await collect(log, await booking(rng, ops));
      for (let i = 0; i < 2; i++) await collect(log, await cancellation(rng, ops));
      for (let i = 0; i < 2; i++) await collect(log, await walkIn(rng, ops));
      await collect(log, await demographicEdit(rng, ops));
      for (let i = 0; i < 2; i++) await collect(log, await payment(rng, ops));
      return log;
    }
  },

  "denial-storm": {
    name: "denial-storm",
    description: "Six aging claims come back denied across CARC categories — primes the denial worklist (B4/B5).",
    async run(rng, ops) {
      const log: string[] = [];
      // One representative code per denial category (see CARC_CODES in @dental/shared).
      const carcs = ["16", "96", "97", "197", "45", "50"];
      const claims = await ops.agingClaims(carcs.length);
      if (claims.length === 0) {
        log.push("no aging claims to deny — run the seed or busy-morning first");
        return log;
      }
      for (let i = 0; i < claims.length; i++) {
        const carc = carcs[i % carcs.length];
        await ops.denyClaim(claims[i].claimNum, carc, `Denied by payer; see CARC ${carc}`);
        log.push(`denied claim ${claims[i].claimNum} ($${claims[i].fee}) with CARC ${carc}`);
      }
      return log;
    }
  },

  "preauth-crown": {
    name: "preauth-crown",
    description: "Treatment-plan a crown for an insured patient today — primes the pre-authorization workflow (B3).",
    async run(rng, ops) {
      const log: string[] = [];
      const insured = (await ops.listPatients()).filter((p) => p.planNum > 0);
      if (insured.length === 0) {
        log.push("no insured patients — run the seed first");
        return log;
      }
      const crown = ops.codes().find((c) => c.code === "D2740")!;
      const pat = rng.pick(insured);
      const tooth = rng.pick(["3", "14", "19", "30"]);
      const procNum = await ops.planProcedure({
        patNum: pat.patNum, provNum: rng.int(1, 2), code: crown, toothNum: tooth
      });
      log.push(`treatment-planned ${crown.code} (${crown.descript}) tooth ${tooth} for patient ${pat.patNum} — procedure ${procNum}`);
      return log;
    }
  },

  "treatment-backlog": {
    name: "treatment-backlog",
    description: "Backdate 3 planned-but-unscheduled treatments 30–90 days — primes unscheduled-treatment outreach (C5).",
    async run(rng, ops) {
      const log: string[] = [];
      // Prefer patients with no upcoming visit — outreach (C5) skips anyone
      // already on the schedule, so those are the ones that demo the flow.
      const booked = new Set((await ops.listScheduled(0, 30)).map((a) => a.patNum));
      const all = (await ops.listPatients()).filter((p) => p.planNum > 0);
      const insured = all.filter((p) => !booked.has(p.patNum));
      if (insured.length === 0) insured.push(...all);
      if (insured.length === 0) {
        log.push("no insured patients — run the seed first");
        return log;
      }
      const codes = ["D2740", "D4341", "D2391"]
        .map((c) => ops.codes().find((x) => x.code === c)!)
        .filter(Boolean);
      for (const code of codes) {
        const pat = rng.pick(insured);
        const tooth = code.code === "D2391" || code.code === "D2740" ? rng.pick(["3", "14", "19", "30"]) : "";
        const daysAgo = rng.int(30, 90);
        const procNum = await ops.planProcedure({
          patNum: pat.patNum, provNum: rng.int(1, 2), code, toothNum: tooth, daysAgo
        });
        log.push(`backdated plan: ${code.code} (${code.descript}) for patient ${pat.patNum}, ${daysAgo} days ago — procedure ${procNum}`);
      }
      return log;
    }
  },

  "no-show-week": {
    name: "no-show-week",
    description: "Several patients silently miss appointments — primes no-show risk scoring (C4).",
    async run(rng, ops) {
      const log: string[] = [];
      const recent = await ops.listScheduled(-7, 1);
      const victims = recent.slice(0, 5);
      if (victims.length === 0) {
        log.push("no recent scheduled appointments to no-show");
        return log;
      }
      for (const a of victims) {
        await ops.breakAppointment(a.aptNum, "No-show — patient did not arrive");
        log.push(`no-show: appointment ${a.aptNum} (patient ${a.patNum}) at ${a.startsAt}`);
      }
      return log;
    }
  }
};
