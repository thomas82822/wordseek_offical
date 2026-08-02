/**
 * Migration: Welcome bonus (first-time /start gift) tracking
 * - users.welcome_bonus_claimed : has this user already received their first-time gift score?
 * - users.welcome_bonus_amount  : how much they were gifted (for records/support)
 */
import { type Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("users")
    .addColumn("welcome_bonus_claimed", "boolean", (col) =>
      col.notNull().defaultTo(false),
    )
    .execute();

  await db.schema
    .alterTable("users")
    .addColumn("welcome_bonus_amount", "integer")
    .execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema
    .alterTable("users")
    .dropColumn("welcome_bonus_amount")
    .execute();

  await db.schema
    .alterTable("users")
    .dropColumn("welcome_bonus_claimed")
    .execute();
}
