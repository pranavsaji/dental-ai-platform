import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";
import path from "node:path";

// drizzle-kit bundles this config to CJS, so import.meta.dirname is not
// available — resolve relative to the package cwd instead.
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.PLATFORM_DATABASE_URL ?? "postgres://dental:dental@localhost:5442/dental"
  }
});
