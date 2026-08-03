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

// ── Connection keep-alive ─────────────────────────────────────────────────────
// Heroku Postgres drops idle TCP connections after ~5 minutes of inactivity.
// Without keep-alive, the first query after a quiet period pays a full
// reconnect penalty (~50–200ms) before the user's command gets a response.
//
// Fix: run a lightweight SELECT 1 every 25 seconds so every pool connection
// stays warm and is ready immediately when a user sends a command.
// Only active in production — dev pools don't suffer from cloud idle timeouts.
if (env.NODE_ENV === "production") {
  setInterval(() => {
    pool.query("SELECT 1").catch(() => {});
  }, 25_000);

  // ── Startup: create missing indexes (fire-and-forget, CONCURRENTLY) ────────
  // These indexes dramatically speed up /score, /leaderboard, and daily-wordle
  // queries. CREATE INDEX CONCURRENTLY never blocks reads or writes — it builds
  // in the background. IF NOT EXISTS makes it a no-op on subsequent restarts.
  //
  // leaderboard(userId)            — getUserScores + getSmartDefaults user filter
  // leaderboard(chatId, wordLength, createdAt) — group-scoped leaderboard queries
  // leaderboard(userId, chatId, createdAt)     — per-user score lookups
  // dailyGuesses(userId, dailyWordId)          — daily-wordle guess retrieval
  // guesses(gameId)                            — guess list per active game
  const STARTUP_INDEXES = [
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lb_userid
       ON leaderboard("userId")`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lb_chat_wl_ts
       ON leaderboard("chatId", "wordLength", "createdAt")`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lb_user_chat_ts
       ON leaderboard("userId", "chatId", "createdAt")`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_guesses_user_word
       ON "dailyGuesses"("userId", "dailyWordId")`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_guesses_gameid
       ON guesses("gameId")`,
  ];
  // Each index is created on its own connection — CONCURRENTLY cannot run
  // inside a transaction or share a connection with other CONCURRENTLY calls.
  for (const stmt of STARTUP_INDEXES) {
    pool.query(stmt).catch(() => {});
  }
}

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
