import { Composer } from "grammy";

import { db } from "../config/db";
import { pe } from "../config/constants";
import { env } from "../config/env";

const composer = new Composer();

composer.command("transfer", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const args = ctx.match.trim().split(/\s+/).filter(Boolean);

  if (args.length !== 2) {
    return ctx.reply(
      "Usage: /transfer <from_user> <to_user>\n" +
        "Example: /transfer @username1 @username2\n" +
        "Or: /transfer user_id_1 user_id_2",
    );
  }

  const [fromIdentifier, toIdentifier] = args;

  // Early same-identifier check
  if (fromIdentifier.toLowerCase() === toIdentifier.toLowerCase()) {
    return ctx.reply(`${pe("❌")} Cannot transfer to the same account.`);
  }

  const getUser = async (identifier: string) => {
    const isUsername = identifier.startsWith("@");
    return await db
      .selectFrom("users")
      .selectAll()
      .where(
        isUsername ? "username" : "id",
        "=",
        isUsername ? identifier.substring(1) : identifier,
      )
      .executeTakeFirst();
  };

  const fromUser = await getUser(fromIdentifier);
  const toUser = await getUser(toIdentifier);

  if (!fromUser) {
    return ctx.reply(`${pe("❌")} Source user not found: ${fromIdentifier}`);
  }

  if (!toUser) {
    return ctx.reply(`${pe("❌")} Destination user not found: ${toIdentifier}`);
  }

  if (fromUser.id === toUser.id) {
    return ctx.reply(`${pe("❌")} Cannot transfer to the same account.`);
  }

  try {
    const leaderboardEntries = await db
      .selectFrom("leaderboard")
      .selectAll()
      .where("userId", "=", fromUser.id)
      .execute();

    if (leaderboardEntries.length === 0) {
      return ctx.reply(
        `${pe("ℹ️")} ${fromUser.name} has no leaderboard entries to transfer`,
      );
    }

    await db
      .updateTable("leaderboard")
      .set({ userId: toUser.id })
      .where("userId", "=", fromUser.id)
      .execute();

    const totalScore = leaderboardEntries.reduce(
      (sum, entry) => sum + entry.score,
      0,
    );

    await ctx.reply(
      `${pe("✅")} Successfully transferred leaderboard data:\n\n` +
        `From: ${fromUser.name} (${fromUser.id})\n` +
        `To: ${toUser.name} (${toUser.id})\n\n` +
        `Entries transferred: ${leaderboardEntries.length}\n` +
        `Total score transferred: ${totalScore}`,
    );
  } catch (error) {
    console.error("Error transferring leaderboard:", error);
    await ctx.reply(`${pe("❌")} An error occurred while transferring leaderboard data`);
  }
});

export const transferCommand = composer;
