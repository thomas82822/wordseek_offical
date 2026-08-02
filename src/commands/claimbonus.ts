/**
 * /claimbonus — User command (DM only).
 * Fix 3: Minimum score lowered to 1,000 (from 50,000).
 * Pending drops stored until 1k score is reached.
 */

import { Composer } from "grammy";
import { sql } from "kysely";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";
import { logBonusClaimRequest } from "../services/logging";

const composer = new Composer();

// Fix 3: Lowered from 50,000 to 1,000
const MIN_SCORE_REQUIRED = 1_000;

composer.command("claimbonus", async (ctx) => {
  if (!ctx.from) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply(`${pe("🎁")} Use this command in my DM to claim your bonus!`);
  }

  const userId = ctx.from.id.toString();
  const userName =
    ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
  const userUsername = ctx.from.username ?? null;

  await db
    .insertInto("users")
    .values({ id: userId, name: userName, username: userUsername })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({ name: userName, username: userUsername }),
    )
    .execute();

  // Check daily cooldown
  const cooldownKey = `bonus_claim:${userId}`;
  const alreadyClaimed = await redis.get(cooldownKey);
  if (alreadyClaimed) {
    return ctx.reply(
      `${pe("⏳")} <b>Already Claimed Today</b>\n\n` +
        `You can only claim one bonus per day.\nCome back tomorrow for another chance! ${pe("🌅")}`,
      { parse_mode: "HTML" },
    );
  }

  // Check total score across ALL word lengths
  const scoreResult = await db
    .selectFrom("leaderboard")
    .where("userId", "=", userId)
    .select(sql<number>`cast(sum(score) as integer)`.as("total"))
    .executeTakeFirst();

  const totalScore = Number(scoreResult?.total ?? 0);

  if (totalScore < MIN_SCORE_REQUIRED) {
    // Store a pending drop for when they reach 1k
    const dropKey = `pending_drop:${userId}`;
    const existingDrop = await redis.get(dropKey);
    if (!existingDrop) {
      const pendingAmount = Math.floor(Math.random() * 4_951) + 50;
      await redis.set(
        dropKey,
        JSON.stringify({ amount: pendingAmount, grantedAt: Date.now() }),
        "EX",
        86400 * 30,
      );
    }

    const needed = MIN_SCORE_REQUIRED - totalScore;

    return ctx.reply(
      `${pe("❌")} <b>Not Eligible Yet</b>\n\n` +
        `<blockquote>You need at least <b>1,000 total score</b> to claim a bonus.\n\n` +
        `${pe("📊")} Your current score: <code>${totalScore.toLocaleString()}</code>\n` +
        `${pe("🎯")} Required: <code>${MIN_SCORE_REQUIRED.toLocaleString()}</code>\n` +
        `${pe("📈")} You need <code>${needed.toLocaleString()}</code> more points.\n\n` +
        `${pe("🎁")} A bonus drop has been reserved for you!\n` +
        `You'll be notified when you reach 1,000.</blockquote>\n\n` +
        `Keep playing to unlock this reward! ${pe("🔥")}`,
      { parse_mode: "HTML" },
    );
  }

  // Check for pending drop (from promo when user had < 1k)
  const dropKey = `pending_drop:${userId}`;
  const rawDrop = await redis.get(dropKey);
  let bonusScore: number;

  if (rawDrop) {
    try {
      const drop = JSON.parse(rawDrop);
      bonusScore = drop.amount;
      await redis.del(dropKey);
    } catch {
      bonusScore = Math.floor(Math.random() * 49_951) + 50;
    }
  } else {
    bonusScore = Math.floor(Math.random() * 49_951) + 50;
  }

  const requestId = Date.now();

  await redis.set(
    `bonus_req:${requestId}`,
    JSON.stringify({
      requestId,
      userId,
      userName,
      userUsername,
      bonusScore,
      highestSource: totalScore,
      createdAt: Date.now(),
    }),
    "EX",
    86400 * 7,
  );

  await redis.set(cooldownKey, "1", "EX", 86400);

  await logBonusClaimRequest({
    requestId,
    user: { id: userId, name: userName, username: userUsername },
    bonusScore,
    highestSource: totalScore,
  });

  await ctx.reply(
    `${pe("🎁")} <b>Bonus Claim Submitted!</b>\n\n` +
      `<blockquote>${pe("✨")} Your lucky bonus: <code>${bonusScore.toLocaleString()}</code> pts\n` +
      `${pe("📊")} Your total score: <code>${totalScore.toLocaleString()}</code>\n` +
      `${pe("🆔")} Request ID: <code>${requestId}</code></blockquote>\n\n` +
      `The owner will review and approve your claim.\n` +
      `Once approved, the bonus will be added to your leaderboard! ${pe("🏆")}\n\n` +
      `<i>You can claim once per day.</i>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand("claimbonus", "Claim your daily bonus score (DM only)");

export const claimBonusCommand = composer;
