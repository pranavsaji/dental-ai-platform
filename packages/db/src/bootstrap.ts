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

const userDefs = [
  { email: "admin@dental.dev", name: "Dana Admin", role: "admin", locationId: null as number | null },
  { email: "frontdesk@dental.dev", name: "Frank Desk", role: "staff", locationId: locA.id },
  { email: "drpatel@dental.dev", name: "Dr. Priya Patel", role: "provider", locationId: null }
];
for (const u of userDefs) {
  const existing = await db.select().from(schema.users).where(eq(schema.users.email, u.email));
  if (existing.length === 0) {
    await db.insert(schema.users).values({
      orgId: org.id,
      email: u.email,
      name: u.name,
      role: u.role,
      locationId: u.locationId,
      passwordHash: scryptHash("dental-demo")
    });
    console.log(`Created user ${u.email} (password: dental-demo)`);
  }
}

console.log("Bootstrap complete.");
await pool.end();
