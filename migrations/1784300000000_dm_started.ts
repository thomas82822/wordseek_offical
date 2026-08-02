/**
 * Migration: users.dm_started
 * Tracks whether a user has ever messaged the bot in private chat.
 * Used to detect "unknown" group participants who haven't DM'd the bot yet,
 * so we can nudge them once with a reward prompt.
 */
import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("users")
    .addColumn("dm_started", "boolean", (col) => col.notNull().defaultTo(false))
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable("users").dropColumn("dm_started").execute();
}
