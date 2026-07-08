import { createDb, type Db } from "@dental/db";

export const DB = "DB_CONNECTION";
export type { Db };

export const dbProvider = {
  provide: DB,
  useFactory: (): Db =>
    createDb(process.env.PLATFORM_DATABASE_URL ?? "postgres://dental:dental@localhost:5442/dental")
};
