import type { Kysely } from "kysely";

export async function up(db: Kysely<any>): Promise<void> {
  // Speeds up "guess already used in this chat?" lookup on every guess
  await db.schema
    .createIndex("guesses_chat_id_guess_idx")
    .on("guesses")
    .columns(["chat_id", "guess"])
    .execute()
    .catch(() => {}); // ignore if already exists

  // Speeds up win-flow "how many guesses did this game have?" query
  await db.schema
    .createIndex("guesses_game_id_idx")
    .on("guesses")
    .column("game_id")
    .execute()
    .catch(() => {});

  // Speeds up leaderboard aggregations by user
  await db.schema
    .createIndex("leaderboard_user_id_idx")
    .on("leaderboard")
    .column("user_id")
    .execute()
    .catch(() => {});

  // Speeds up group-scoped leaderboard queries
  await db.schema
    .createIndex("leaderboard_chat_id_idx")
    .on("leaderboard")
    .column("chat_id")
    .execute()
    .catch(() => {});

  // Composite index for group leaderboard (chat + user aggregation)
  await db.schema
    .createIndex("leaderboard_chat_user_idx")
    .on("leaderboard")
    .columns(["chat_id", "user_id"])
    .execute()
    .catch(() => {});
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex("guesses_chat_id_guess_idx").execute().catch(() => {});
  await db.schema.dropIndex("guesses_game_id_idx").execute().catch(() => {});
  await db.schema.dropIndex("leaderboard_user_id_idx").execute().catch(() => {});
  await db.schema.dropIndex("leaderboard_chat_id_idx").execute().catch(() => {});
  await db.schema.dropIndex("leaderboard_chat_user_idx").execute().catch(() => {});
}
