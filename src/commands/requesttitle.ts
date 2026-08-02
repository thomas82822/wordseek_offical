/**
 * /requesttitle <desired title>
 *
 * Users who have earned a score-based title can request a custom display title.
 * The request is sent to the owner's logs channel for approval.
 * Owner approves or rejects via inline buttons.
 *
 * Redis keys:
 *   custom_title:{userId}        — approved custom title for a user
 *   title_req:{userId}           — pending request (expires 7 days)
 */

import { Composer } from "grammy";

import { sql } from "kysely";

import { bot } from "../config/bot";
import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { getTitleForScore } from "../config/title-config";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

const MAX_TITLE_LEN = 32;

composer.command("requesttitle", async (ctx) => {
  if (!ctx.from) return;

  const desired = ctx.match.trim();

  if (!desired) {
    return ctx.reply(
      `${pe("✏️")} <b>Request a Custom Title</b>\n\n` +
        `Usage: <code>/requesttitle Your Custom Title</code>\n\n` +
        `Your custom title will replace your score-based title on the leaderboard.\n` +
        `Max ${MAX_TITLE_LEN} characters. Must be approved by the owner.`,
      { parse_mode: "HTML" },
    );
  }

  if (desired.length > MAX_TITLE_LEN) {
    return ctx.reply(
      `${pe("⚠️")} Title too long. Max ${MAX_TITLE_LEN} characters (yours: ${desired.length}).`,
      { parse_mode: "HTML" },
    );
  }

  // Basic sanity: no HTML
  if (/<[^>]*>/.test(desired)) {
    return ctx.reply(`${pe("⚠️")} Title cannot contain HTML tags.`);
  }

  const userId = ctx.from.id.toString();

  // User must have a score-based title earned through gameplay
  const scoreRow = await db
    .selectFrom("leaderboard")
    .select(sql<number>`cast(sum(score) as integer)`.as("total"))
    .where("userId", "=", userId)
    .executeTakeFirst()
    .catch(() => null);
  const totalScore = scoreRow?.total ?? 0;
  const currentTitle = getTitleForScore(totalScore);

  if (!currentTitle) {
    return ctx.reply(
      `${pe("🔒")} <b>Not eligible yet!</b>\n\n` +
        `You need to earn a score-based title first before requesting a custom one.\n` +
        `Keep playing to unlock your first title! ${pe("💪")}`,
      { parse_mode: "HTML" },
    );
  }

  // Check if they already have a pending request
  const pendingKey = `title_req:${userId}`;
  const pending = await redis.get(pendingKey);
  if (pending) {
    return ctx.reply(
      `${pe("⏳")} <b>Request Pending</b>\n\n` +
        `Your previous title request "<b>${pending}</b>" is still awaiting review.\n` +
        `Please wait for the owner to approve or reject it before submitting a new one.`,
      { parse_mode: "HTML" },
    );
  }

  // Store the request
  await redis.set(pendingKey, desired, "EX", 7 * 86400);

  // Notify owner's logs channel
  if (env.LOGS_CHANNEL) {
    const userName = ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
    const displayName = userName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const desiredHtml = desired.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    try {
      await bot.api.sendMessage(
        env.LOGS_CHANNEL,
        `${pe("✏️")} <b>Custom Title Request</b>\n\n` +
          `<blockquote>👤 User: <b>${displayName}</b> (<code>${userId}</code>)\n` +
          `📊 Score: <code>${totalScore.toLocaleString()}</code> pts\n` +
          `🏷 Current Title: <i>${currentTitle}</i>\n\n` +
          `✍️ Requested Title: <b>${desiredHtml}</b></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `title_approve ${userId}` },
                { text: "❌ Reject",  callback_data: `title_reject ${userId}` },
              ],
            ],
          },
        },
      );
    } catch {}
  }

  await ctx.reply(
    `${pe("📬")} <b>Request Submitted!</b>\n\n` +
      `<blockquote>Your custom title request "<b>${desired.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</b>" has been sent for review.\n\n` +
      `You'll be notified once the owner approves or rejects it. ${pe("🙏")}</blockquote>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand("requesttitle", "Request a custom display title for the leaderboard");

export const requestTitleCommand = composer;
