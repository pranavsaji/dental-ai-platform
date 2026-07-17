// One-time platform bootstrap: pgvector extension, demo org, two locations
// (matching the edge sites), and demo users. Idempotent.
//
// Usage: pnpm --filter @dental/db bootstrap   (after `pnpm --filter @dental/db push`)

import path from "node:path";
import * as dotenv from "dotenv";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";
import { scryptHash } from "./password.js";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../../.env") });

const url = process.env.PLATFORM_DATABASE_URL ?? "postgres://dental:dental@localhost:5442/dental";
const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool, { schema });

await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

let [org] = await db.select().from(schema.orgs).where(eq(schema.orgs.name, "Lone Star Dental Group"));
if (!org) {
  [org] = await db.insert(schema.orgs).values({ name: "Lone Star Dental Group" }).returning();
  console.log("Created org:", org.name);
}

const siteDefs = [
  { key: "a", name: "Austin — North Lamar", apiKeyEnv: "EDGE_SITE_A_API_KEY" },
  { key: "b", name: "Round Rock", apiKeyEnv: "EDGE_SITE_B_API_KEY" }
];
for (const s of siteDefs) {
  const existing = await db.select().from(schema.locations).where(eq(schema.locations.key, s.key));
  if (existing.length === 0) {
    await db.insert(schema.locations).values({
      orgId: org.id,
      key: s.key,
      name: s.name,
      edgeApiKey: process.env[s.apiKeyEnv] ?? `edge-key-site-${s.key}-dev`
    });
    console.log("Created location:", s.name);
  }
}

const locs = await db.select().from(schema.locations);
const locA = locs.find((l) => l.key === "a")!;

// One demo account per role. Dr. Patel is pinned to Austin and linked to the
// PMS provider record DDS1 (ProvNum 1) there — that link is what scopes her
// reads to her own schedule and patients. Billing is org-wide (RCM works both
// sites); front desk is pinned to Austin.
const userDefs = [
  { email: "admin@dental.dev", name: "Dana Admin", role: "admin", locationId: null as number | null, providerSourceId: null as number | null },
  { email: "frontdesk@dental.dev", name: "Frank Desk", role: "staff", locationId: locA.id, providerSourceId: null },
  { email: "drpatel@dental.dev", name: "Dr. Priya Patel", role: "provider", locationId: locA.id, providerSourceId: 1 },
  { email: "billing@dental.dev", name: "Bella Reyes", role: "billing", locationId: null, providerSourceId: null }
];
for (const u of userDefs) {
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, u.email));
  if (!existing) {
    await db.insert(schema.users).values({
      orgId: org.id,
      email: u.email,
      name: u.name,
      role: u.role,
      locationId: u.locationId,
      providerSourceId: u.providerSourceId,
      passwordHash: scryptHash("dental-demo")
    });
    console.log(`Created user ${u.email} (password: dental-demo)`);
  } else if (
    existing.role !== u.role ||
    existing.locationId !== u.locationId ||
    existing.providerSourceId !== u.providerSourceId
  ) {
    // Reconcile pre-RBAC seed rows (e.g. Dr. Patel before the provider link).
    await db.update(schema.users)
      .set({ role: u.role, locationId: u.locationId, providerSourceId: u.providerSourceId })
      .where(eq(schema.users.id, existing.id));
    console.log(`Updated user ${u.email} (role/location/provider link)`);
  }
}

// --- A5: plausible open task queue so /tasks isn't empty on day one ----------
const existingTasks = await db.select().from(schema.tasks).limit(1);
if (existingTasks.length === 0) {
  const taskDefs = [
    { key: "a", type: "manual", title: "Verify November payer remittance batch", body: "Reconcile the last ERA batch against posted payments before month close.", priority: "normal", assigneeRole: "staff" },
    { key: "a", type: "patient_question", title: "Patient asked about crown warranty", body: "Voicemail from a patient asking whether their 2024 crown is covered for replacement. Draft a reply and call back.", priority: "low", assigneeRole: "staff" },
    { key: "a", type: "claim_denial", title: "Review denied claim — missing radiograph", body: "Carrier requested a periapical radiograph before reprocessing. Attach and resubmit.", priority: "high", assigneeRole: "billing" },
    { key: "b", type: "manual", title: "Update carrier fee schedule for PPO renewals", body: "New Delta Dental PPO fee schedule effective next month — load it before claims go out.", priority: "normal", assigneeRole: "admin" },
    { key: "b", type: "eligibility_failure", title: "Eligibility check failed — payer system unavailable", body: "Retry eligibility for tomorrow's 9:00 patient; payer endpoint timed out overnight.", priority: "high", assigneeRole: "billing" }
  ];
  for (const t of taskDefs) {
    const loc = locs.find((l) => l.key === t.key)!;
    await db.insert(schema.tasks).values({
      orgId: org.id, locationId: loc.id, type: t.type, title: t.title, body: t.body,
      priority: t.priority, assigneeRole: t.assigneeRole, createdBy: "bootstrap"
    });
  }
  console.log(`Seeded ${taskDefs.length} open tasks.`);
}

// --- A3/D1: 90 days of daily metrics so analytics charts render on day one ---
// Deterministic synthetic trend (seeded PRNG); D1's nightly rollup overwrites
// rows as real canonical data accrues.
const existingMetrics = await db.select().from(schema.dailyLocationMetrics).limit(1);
if (existingMetrics.length === 0) {
  let s = 424242;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 2 ** 32);
  const rows: (typeof schema.dailyLocationMetrics.$inferInsert)[] = [];
  for (const loc of locs) {
    // Per-site personality so cross-location analytics has a story (D1/D2).
    const baseProduction = loc.key === "a" ? 9200 : 7400;
    const collectRate = loc.key === "a" ? 0.93 : 0.87;
    for (let i = 90; i >= 1; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const drift = 1 + (90 - i) * 0.001; // gentle upward trend
      const production = Math.round(baseProduction * drift * (0.75 + rand() * 0.5));
      const appointments = 18 + Math.floor(rand() * 10);
      const cancels = rand() < 0.7 ? Math.floor(rand() * 3) : 0;
      const noshows = rand() < 0.35 ? 1 : 0;
      rows.push({
        orgId: org.id, locationId: loc.id, date: d.toISOString().slice(0, 10),
        productionScheduled: production,
        productionCompleted: Math.round(production * (0.88 + rand() * 0.1)),
        collections: Math.round(production * collectRate * (0.9 + rand() * 0.15)),
        cancellationCount: cancels, noshowCount: noshows,
        brokenRate: (cancels + noshows) / appointments,
        hygieneReappointmentRate: 0.68 + rand() * 0.2,
        unscheduledTreatmentValue: Math.round(28000 + rand() * 9000),
        ar0_30: Math.round(21000 + rand() * 6000), ar31_60: Math.round(9000 + rand() * 4000),
        ar61_90: Math.round(5200 + rand() * 2500), ar90Plus: Math.round((loc.key === "a" ? 3800 : 7600) + rand() * 2000),
        openClaimsValue: Math.round(15000 + rand() * 8000),
        denialCount: rand() < 0.3 ? 1 : 0,
        newPatients: rand() < 0.6 ? Math.floor(rand() * 3) : 0,
        caseAcceptanceRate: 0.55 + rand() * 0.25,
        appointmentsCount: appointments,
        chairUtilization: 0.62 + rand() * 0.25
      });
    }
  }
  await db.insert(schema.dailyLocationMetrics).values(rows);
  console.log(`Seeded ${rows.length} daily metric rows (90 days x ${locs.length} locations).`);
}

console.log("Bootstrap complete.");
await pool.end();
