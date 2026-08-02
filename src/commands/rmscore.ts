/**
 * /rmscore <identifier> <amount|all> [4|5|6]
 *
 * Remove score from a user's leaderboard (admin/owner only).
 * - /rmscore @user 500        → subtract 500 pts from 5-letter mode
 * - /rmscore @user 500 4      → subtract 500 pts from 4-letter mode
 * - /rmscore @user all        → wipe ALL leaderboard entries for the user
 * - /rmscore @user all 6      → wipe only 6-letter entries for the user
 */

import { Composer } from "grammy";
import { sql } from "kysely";

import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { isBotAdmin } from "../util/guards";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

composer.command("rmscore", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const args = ctx.match.trim().split(/\s+/);
  if (args.length < 2) {
    return ctx.reply(
      "Usage:\n" +
        "<code>/rmscore @user|id &lt;amount&gt; [4|5|6]</code>\n" +
        "<code>/rmscore @user|id all [4|5|6]</code>",
      { parse_mode: "HTML" },
    );
  }

  const [identifier, amountStr, lengthStr] = args;
  const removeAll = amountStr.toLowerCase() === "all";

  // Validate amount
  const amount = removeAll ? 0 : parseInt(amountStr);
  if (!removeAll && (isNaN(amount) || amount <= 0)) {
    return ctx.reply(
      `${pe("❌")} Amount must be a positive number, or use <code>all</code> to wipe all entries.`,
      { parse_mode: "HTML" },
    );
  }

  // Validate word length (optional)
  const wordLength = lengthStr ? parseInt(lengthStr) : null;
  if (wordLength !== null && ![4, 5, 6].includes(wordLength)) {
    return ctx.reply(`${pe("❌")} Word length must be 4, 5, or 6.`);
  }

  // Lookup user
  const isUsername = identifier.startsWith("@");
  const user = await db
    .selectFrom("users")
    .select(["id", "name", "username"])
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

  const mention = user.username ? `@${user.username}` : escHtml(user.name);

  // ── Wipe mode ─────────────────────────────────────────────────────────────
  if (removeAll) {
    let query = db.deleteFrom("leaderboard").where("userId", "=", user.id);
    if (wordLength) {
      query = query.where("wordLength", "=", wordLength.toString() as "4" | "5" | "6");
    }
    const result = await query.executeTakeFirst();
    const deleted = Number(result?.numDeletedRows ?? 0);

    return ctx.reply(
      `${pe("🗑️")} <b>Score Wiped</b>\n\n` +
        `<blockquote>${pe("👤")} User: ${mention}\n` +
        `${pe("🆔")} ID: <code>${user.id}</code>\n` +
        `${pe("📏")} Mode: ${wordLength ? `${wordLength}-letter` : "All modes"}\n` +
        `${pe("🔢")} Entries removed: <code>${deleted}</code></blockquote>`,
      { parse_mode: "HTML" },
    );
  }

  // ── Subtract mode ─────────────────────────────────────────────────────────
  // Get current total so we can clamp: score can't go below 0
  const wl = (wordLength ?? 5).toString() as "4" | "5" | "6";

  const totRow = await db
    .selectFrom("leaderboard")
    .select(sql<number>`cast(coalesce(sum(score), 0) as integer)`.as("total"))
    .where("userId", "=", user.id)
    .where("wordLength", "=", wl)
    .executeTakeFirst();

  const currentTotal = totRow?.total ?? 0;
  const actualDeduct = Math.min(amount, currentTotal); // clamp so total never goes negative

  await db
    .insertInto("leaderboard")
    .values({
      userId: user.id,
      chatId: "admin",
      score: -actualDeduct,
      wordLength: wl,
    })
    .execute();

  return ctx.reply(
    `${pe("✅")} <b>Score Removed</b>\n\n` +
      `<blockquote>${pe("👤")} User: ${mention}\n` +
        `${pe("🆔")} ID: <code>${user.id}</code>\n` +
        `${pe("📉")} Removed: <code>${actualDeduct.toLocaleString()}</code> pts\n` +
        `${pe("📏")} Mode: ${wl}-letter\n` +
        `${pe("💯")} New total: <code>${(currentTotal - actualDeduct).toLocaleString()}</code> pts</blockquote>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand("rmscore", "Remove score from a user (admin only)", true);

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const rmScoreCommand = composer;
