/**
 * Migration: user_chats
 * Tracks every (user, group chat) pair the bot has ever seen a message from.
 * This is the "known users of each group" registry — every group member who
 * has sent at least one message is recorded here, even before/without ever
 * DM-verifying the bot (verification only gates whether their word guesses
 * are read, not whether they're tracked as a known participant).
 */
import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable("user_chats")
    .addColumn("user_id", "text", (col) => col.notNull())
    .addColumn("chat_id", "text", (col) => col.notNull())
    .addColumn("chat_title", "text")
    .addColumn("first_seen_at", "timestamptz", (col) =>
      col.notNull().defaultTo(new Date().toISOString()),
    )
    .addColumn("last_seen_at", "timestamptz", (col) =>
      col.notNull().defaultTo(new Date().toISOString()),
    )
    .addPrimaryKeyConstraint("user_chats_pkey", ["user_id", "chat_id"])
    .execute();

  await db.schema
    .createIndex("user_chats_chat_id_idx")
    .on("user_chats")
    .column("chat_id")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable("user_chats").execute();
}
