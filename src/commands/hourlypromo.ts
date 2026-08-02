/**
 * Hourly promo system
 *
 * /promoson  — Enable hourly promos (owner/admin only)
 * /promosoff — Disable hourly promos (owner/admin only)
 *
 * When enabled, sends & pins the promo message every hour to all
 * registered group chats only. No DMs are ever sent.
 * Previous promo message is deleted before the new one is pinned.
 */

import { Composer } from "grammy";
import { CronJob } from "cron";

import { bot } from "../config/bot";
import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { isBotAdmin } from "../util/guards";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

const PROMO_ENABLED_KEY = "promos:enabled";

// ── Shared promo builder ───────────────────────────────────────────────────────

function buildPromoText(): string {
  return (
    `${pe("🎮")} <b>WordSeek — Play &amp; Win!</b>\n\n` +
    `<blockquote>Challenge your word skills right here on Telegram!\n\n` +
    `• Guess the hidden word before others\n` +
    `• Earn bonus points &amp; climb the leaderboard!\n\n` +
    `${pe("🔥")} <b>Start a game right now:</b>\n` +
    `/new4 — 4-letter word\n` +
    `/new5 — 5-letter word\n` +
    `/new6 — 6-letter word\n\n` +
    `${pe("🏆")} Top scorers win big!</blockquote>`
  );
}

function buildPromoKeyboard(botUsername: string) {
  if (!botUsername) return undefined;
  return {
    inline_keyboard: [[
      { text: "🎮 Play Now", url: `https://t.me/${botUsername}?start=promo` },
    ]],
  };
}

/** Send + pin promo in one group chat. Cleans up previous message. */
async function sendAndPinPromo(chatId: number | string): Promise<void> {
  const key = `promo_last_msg:${chatId}`;
  const botUsername = bot.botInfo?.username ?? "";

  // Delete previous promo message
  const lastId = await redis.get(key);
  if (lastId) {
    try { await bot.api.deleteMessage(chatId, parseInt(lastId)); } catch {}
    await redis.del(key);
  }

  // Send to group only
  const sent = await bot.api.sendMessage(chatId, buildPromoText(), {
    parse_mode: "HTML",
    reply_markup: buildPromoKeyboard(botUsername),
  });

  // Store for next cleanup (7 days)
  await redis.set(key, sent.message_id.toString(), "EX", 86400 * 7);

  // Pin silently
  try {
    await bot.api.pinChatMessage(chatId, sent.message_id, {
      disable_notification: true,
    });
  } catch {
    // No pin permission — skip
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────

composer.command("promoson", async (ctx) => {
  if (!ctx.from) return;
  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  await redis.set(PROMO_ENABLED_KEY, "1");
  await ctx.reply(
    `${pe("✅")} <b>Hourly promos enabled!</b>\n\n` +
    `<blockquote>Promo will be sent &amp; pinned every hour in all registered groups.\n` +
    `Previous message auto-deleted. No DMs sent.</blockquote>`,
    { parse_mode: "HTML" },
  );
});

composer.command("promosoff", async (ctx) => {
  if (!ctx.from) return;
  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  await redis.del(PROMO_ENABLED_KEY);
  await ctx.reply(`${pe("⛔")} <b>Hourly promos disabled.</b>`, { parse_mode: "HTML" });
});

/**
 * /sendpin — Manually send & pin promo in THIS group right now.
 * Owner only. Group/supergroup only — silently ignored in DMs.
 */
composer.command("sendpin", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") return; // silent in DMs

  try {
    await sendAndPinPromo(ctx.chat.id);
  } catch (err) {
    console.error("sendpin error:", err);
  }
});

CommandsHelper.addNewCommand("promoson", "Enable hourly promos in all groups (owner only)", true);
CommandsHelper.addNewCommand("promosoff", "Disable hourly promos (owner only)", true);
CommandsHelper.addNewCommand("sendpin", "Send & pin promo in this group now (owner only)", true);

// ── Hourly Cron ───────────────────────────────────────────────────────────────

// ── Pending-drop notification ─────────────────────────────────────────────────

/**
 * Called once when a user crosses the 1,000-point milestone.
 * If they have a reserved pending drop (stored by /claimbonus), send them a DM.
 */
export async function notifyPendingDropIfAny(userId: string): Promise<void> {
  try {
    const dropKey = `pending_drop:${userId}`;
    const rawDrop = await redis.get(dropKey);
    if (!rawDrop) return; // no pending drop — nothing to do

    let amount: number | null = null;
    try {
      const drop = JSON.parse(rawDrop);
      amount = typeof drop.amount === "number" ? drop.amount : null;
    } catch {
      // malformed — still notify without amount
    }

    const amountLine = amount !== null
      ? `\n${pe("🎁")} Reserved bonus: <code>${amount.toLocaleString()}</code> pts`
      : "";

    await bot.api.sendMessage(
      userId,
      `${pe("🎉")} <b>You've hit 1,000 points!</b>\n\n` +
        `<blockquote>You crossed the 1,000-score milestone — great work!${amountLine}\n\n` +
        `${pe("✨")} Use /claimbonus in this chat to collect your reserved bonus.</blockquote>`,
      { parse_mode: "HTML" },
    );
  } catch {
    // User may have never started the bot (DM blocked) — silently ignore
  }
}

// ── Hourly Cron ───────────────────────────────────────────────────────────────

export const hourlyPromoCron = new CronJob(
  "0 * * * *",
  async () => {
    try {
      if (!(await redis.get(PROMO_ENABLED_KEY))) return;

      // Fetch all registered group chats
      const chats = await db
        .selectFrom("broadcastChats")
        .select(["id"])
        .execute();

      if (chats.length === 0) return;

      for (const chat of chats) {
        try {
          await sendAndPinPromo(chat.id);
          await new Promise((r) => setTimeout(r, 300)); // rate-limit
        } catch {
          // Group removed bot — skip
        }
      }
    } catch (err) {
      console.error("Hourly promo cron error:", err);
    }
  },
  null,
  false,
  env.TIME_ZONE || "UTC",
);

export const hourlyPromoCommand = composer;
