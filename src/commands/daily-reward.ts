/**
 * /dailyreward — Claim a free daily score (5–1000 pts, once per 24 hours)
 */

import { Composer } from "grammy";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { pe, randomPremiumEmoji } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

composer.command("dailyreward", async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== "private") {
    return ctx.reply(
      `${pe("🎁")} Please use /dailyreward in my DM to claim your daily reward!`,
      { parse_mode: "HTML" },
    );
  }

  const userId = ctx.from?.id.toString();
  if (!userId) return;

  const key = `daily_reward:${userId}`;
  const claimed = await redis.get(key);

  if (claimed) {
    const ttl = await redis.ttl(key);
    const hoursLeft = Math.ceil(ttl / 3600);
    const minsLeft = Math.ceil((ttl % 3600) / 60);

    return ctx.reply(
      `${pe("⏳")} <b>Already Claimed!</b>\n\n` +
        `<blockquote>You've already claimed your daily reward.\n\n` +
        `⏰ Next reward in: <b>${hoursLeft > 0 ? `${hoursLeft}h ` : ""}${minsLeft}m</b></blockquote>`,
      { parse_mode: "HTML" },
    );
  }

  // Weighted random: most rewards are small, rare big ones
  const roll = Math.random();
  let reward: number;
  let tier: string;
  if (roll < 0.50) {
    reward = 5 + Math.floor(Math.random() * 46);   // 50%: 5–50 pts
    tier = "Common";
  } else if (roll < 0.80) {
    reward = 50 + Math.floor(Math.random() * 151);  // 30%: 50–200 pts
    tier = "Uncommon";
  } else if (roll < 0.95) {
    reward = 200 + Math.floor(Math.random() * 301); // 15%: 200–500 pts
    tier = "Rare";
  } else {
    reward = 500 + Math.floor(Math.random() * 501); // 5%: 500–1000 pts
    tier = "Legendary 🌟";
  }

  await db
    .insertInto("leaderboard")
    .values({ userId, chatId: "daily_reward", score: reward, wordLength: "5" })
    .execute()
    .catch(() => {});

  await redis.set(key, reward.toString(), "EX", 86400); // 24-hour cooldown

  const tierEmoji = tier === "Legendary 🌟" ? pe("🌟") : tier === "Rare" ? pe("💎") : tier === "Uncommon" ? pe("✨") : pe("🎁");

  await ctx.reply(
    `${randomPremiumEmoji()} <b>Daily Reward Claimed!</b>\n\n` +
      `<blockquote>${tierEmoji} Tier: <b>${tier}</b>\n\n` +
      `${pe("💰")} You received <b>+${reward.toLocaleString()} pts</b>!\n\n` +
      `Come back tomorrow for another reward. ${pe("🔥")}</blockquote>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand("dailyreward", "Claim your free daily score reward");

export const dailyRewardCommand = composer;
