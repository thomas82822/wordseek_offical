/**
 * Migration: New feature tables
 * - bot_admins      : DB-granted bot admin accounts
 * - frozen_users    : Anti-cheat frozen users
 */
import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // ── bot_admins ─────────────────────────────────────────────────────────
  await db.schema
    .createTable("bot_admins")
    .ifNotExists()
    .addColumn("user_id", "text", (col) =>
      col.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("granted_by", "text")
    .addColumn("created_at", "timestamptz", (col) =>
      col.defaultTo(sql`now()`).notNull(),
    )
    .execute();

  // ── frozen_users ────────────────────────────────────────────────────────
  await db.schema
    .createTable("frozen_users")
    .ifNotExists()
    .addColumn("user_id", "text", (col) =>
      col.primaryKey().references("users.id").onDelete("cascade"),
    )
    .addColumn("reason", "text")
    .addColumn("frozen_at", "timestamptz", (col) =>
      col.defaultTo(sql`now()`).notNull(),
    )
    .addColumn("created_at", "timestamptz", (col) =>
      col.defaultTo(sql`now()`).notNull(),
    )
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("frozen_users").ifExists().execute();
  await db.schema.dropTable("bot_admins").ifExists().execute();
}
