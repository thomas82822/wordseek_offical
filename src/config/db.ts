import {
  CamelCasePlugin,
  DeduplicateJoinsPlugin,
  Kysely,
  PostgresDialect,
} from "kysely";
import pg from "pg";

import type { DB } from "../database-schemas";
import { env } from "./env";

const { Pool } = pg;

// ── Connection pool tuning ────────────────────────────────────────────────────
// Heroku Postgres hobby/basic tier allows max 25 connections.
// Keep pool at 10 so we never saturate Heroku's limit — leaves headroom for
// other tools (migrations, admin queries) and for connection churn.
// On Standard-0 and above (120 connections) you can raise max to 20–30.
//
// statement_timeout: 8 s — kills runaway queries so they don't hold pool
//   connections forever and cause cascade hangs.
// idle_in_transaction_session_timeout: 5 s — cleans up abandoned transactions.

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.NODE_ENV === "production" ? 10 : 5,
  idleTimeoutMillis: 30_000,       // Release idle connections after 30 s
  connectionTimeoutMillis: 8_000,  // Wait up to 8 s for a pool slot (was 3 s — too short, caused silent drops)
  ssl:
    env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});

// Set statement_timeout and idle_in_transaction_session_timeout for every new
// connection so slow queries never block the pool.
pool.on("connect", (client) => {
  client.query(
    "SET statement_timeout = '8000'; SET idle_in_transaction_session_timeout = '5000';",
  ).catch(() => {});
});

const dialect = new PostgresDialect({ pool });

export const db = new Kysely<DB>({
  dialect,
  log: (event) => {
    if (env.NODE_ENV === "development") {
      if (event.level === "query") {
        console.log("SQL:", event.query.sql);
        console.log("Parameters:", event.query.parameters);
      } else {
        console.error("Error:", event.error);
      }
      console.log("-------------");
    }
  },
  plugins: [new CamelCasePlugin(), new DeduplicateJoinsPlugin()],
});
