import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

// Host port 5435 (infra/compose.yaml) so local edc-core (5432), ctms (5433),
// and lims (5434) Postgres instances never get hit by accident.
export const DEFAULT_DATABASE_URL = "postgres://rtsm:rtsm-dev-only@localhost:5435/rtsm";

/** Owner/migration connection string. */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/**
 * Runtime connection string for the DML-only rtsm_app role (0002). Falls back
 * to the owner URL so tests and local hacking work against a bare database;
 * the deployed API must set APP_DATABASE_URL to keep least privilege real.
 */
export function appDatabaseUrl(): string {
  return process.env.APP_DATABASE_URL ?? databaseUrl();
}

export function createDb(url = appDatabaseUrl()) {
  const client = postgres(url, { onnotice: () => {} });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>["db"];
