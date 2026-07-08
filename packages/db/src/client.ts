import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return drizzle(pool, { schema });
}
