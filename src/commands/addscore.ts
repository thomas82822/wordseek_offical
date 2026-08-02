/**
 * /addscore <identifier> <amount> [wordlength]
 * Manually add score to a user's leaderboard (admin/owner only).
 * wordlength defaults to 5 if not specified.
 */

import { Composer } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { isBotAdmin } from "../util/guards";

const composer = new Composer();

composer.command("addscore", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const args = ctx.match.trim().split(/\s+/);
  if (args.length < 2) {
    return ctx.reply(
      "Usage: <code>/addscore @username|userid &lt;amount&gt; [4|5|6]</code>",
      { parse_mode: "HTML" },
    );
  }

  const [identifier, amountStr, lengthStr] = args;
  const amount = parseInt(amountStr);

  if (isNaN(amount) || amount <= 0) {
    return ctx.reply(`${pe("❌")} Amount must be a positive number.`);
  }

  const wordLength = lengthStr ? parseInt(lengthStr) : 5;
  if (![4, 5, 6].includes(wordLength)) {
    return ctx.reply(`${pe("❌")} Word length must be 4, 5, or 6.`);
  }

  const isUsername = identifier.startsWith("@");
  const user = await db
    .selectFrom("users")
    .selectAll()
    .where(
      isUsername ? "username" : "id",
      "=",
      isUsername ? identifier.substring(1) : identifier,
    )
    .executeTakeFirst();

  if (!user) {
    return ctx.reply(
      `${pe("❌")} User not found. They must have started the bot at least once.`,
    );
  }

  await db
    .insertInto("leaderboard")
    .values({
      userId: user.id,
      chatId: "admin",
      score: amount,
      wordLength: wordLength.toString() as "4" | "5" | "6",
    })
    .execute();

  const mention = user.username
    ? `@${user.username}`
    : escHtml(user.name);

  await ctx.reply(
    `${pe("✅")} <b>Score Added</b>\n\n` +
      `<blockquote>${pe("👤")} User: ${mention}\n` +
      `${pe("🆔")} ID: <code>${user.id}</code>\n` +
      `${pe("💯")} Added: <code>${amount.toLocaleString()}</code> pts\n` +
      `${pe("📏")} Mode: ${wordLength}-letter</blockquote>`,
    { parse_mode: "HTML" },
  );
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const addScoreCommand = composer;
