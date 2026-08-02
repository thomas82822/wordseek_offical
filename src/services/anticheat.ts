/**
 * Anti-cheat service
 *
 * Freeze logic — MANUAL APPROVAL ONLY (bot never auto-freezes):
 *   - 1 min  : > 180 points → send freeze REQUEST to log channel (owner approves)
 *   - 5 min  : > 700 points → send freeze REQUEST to log channel
 *   - 10 min : > 1500 points → send freeze REQUEST to log channel
 *
 * Multiple-GC rule:
 *   - If a user earns score in ≥ 2 different group chats within 10 minutes → request
 *
 * Owner approves/rejects via inline button in the anticheat log channel.
 * Frozen users: score is NOT added to leaderboard while frozen.
 * Owner (ADMIN_USERS) is NEVER frozen.
 */

import { bot } from "../config/bot";
import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { redis } from "../config/redis";
import { memCache } from "../config/cache";
import { InlineKeyboard } from "grammy";

export interface ScoreEvent {
  ts: number;      // Unix ms timestamp
  score: number;
  chatId: string;
}

const WINDOWS = [
  { ms: 60_000,     maxScore: 180,  label: "1 minute"  },
  { ms: 300_000,    maxScore: 700,  label: "5 minutes" },
  { ms: 600_000,    maxScore: 1500, label: "10 minutes" },
] as const;

const MULTI_GC_WINDOW_MS = 600_000; // 10 minutes
const MULTI_GC_MIN_CHATS = 2;

/**
 * Record a score event and check if user should be flagged.
 * Returns `true` if user is already frozen (score should NOT be counted).
 * Returns `false` if user is clean.
 * NEVER auto-freezes — only sends freeze request to log channel for owner approval.
 */
export async function checkAndMaybeFreeze(
  userId: string,
  score: number,
  chatId: string,
): Promise<boolean> {
  // Owners are never frozen
  if (env.ADMIN_USERS.includes(parseInt(userId))) return false;

  // If already frozen, block score
  if (await isUserFrozen(userId)) return true;

  const key = `anticheat:events:${userId}`;
  const now = Date.now();

  const raw = await redis.get(key);
  const events: ScoreEvent[] = raw ? JSON.parse(raw) : [];

  events.push({ ts: now, score, chatId });

  const cutoff = now - MULTI_GC_WINDOW_MS;
  const recentEvents = events.filter((e) => e.ts >= cutoff);

  await redis.set(key, JSON.stringify(recentEvents), "EX", 700);

  // ── Check score thresholds ────────────────────────────────────────────────
  for (const { ms, maxScore, label } of WINDOWS) {
    const windowCutoff = now - ms;
    const windowEvents = recentEvents.filter((e) => e.ts >= windowCutoff);
    const windowScore = windowEvents.reduce((sum, e) => sum + e.score, 0);

    if (windowScore > maxScore) {
      await requestFreeze(
        userId,
        `Anti-cheat: ${windowScore} points scored in ${label} (limit: ${maxScore})`,
      );
      return false; // Don't block yet — owner must approve freeze
    }
  }

  // ── Check multi-GC rule ───────────────────────────────────────────────────
  const distinctChats = new Set(recentEvents.map((e) => e.chatId));
  if (distinctChats.size >= MULTI_GC_MIN_CHATS) {
    const oldest = Math.min(...recentEvents.map((e) => e.ts));
    const span = now - oldest;
    if (span >= MULTI_GC_WINDOW_MS) {
      await requestFreeze(
        userId,
        `Anti-cheat: scoring in ${distinctChats.size} different groups over 10 minutes`,
      );
      return false;
    }
  }

  return false;
}

/**
 * Send a freeze REQUEST to the anticheat log channel.
 * Owner must approve before the user is actually frozen.
 * Only sends once per cooldown period to avoid spam.
 */
export async function requestFreeze(userId: string, reason: string): Promise<void> {
  if (env.ADMIN_USERS.includes(parseInt(userId))) return;

  // Only request once per 10 minutes per user
  const reqKey = `freeze_req:${userId}`;
  const alreadyRequested = await redis.get(reqKey);
  if (alreadyRequested) return;

  await redis.set(reqKey, "1", "EX", 600);

  const channel = env.ANTICHEAT_LOGS_CHANNEL || env.LOGS_CHANNEL;
  if (!channel) return;

  try {
    const user = await db
      .selectFrom("users")
      .select(["name", "username"])
      .where("id", "=", userId)
      .executeTakeFirst();

    const mention = user?.username
      ? `@${user.username}`
      : user?.name ?? userId;

    const kb = new InlineKeyboard()
      .text("🧊 Freeze", `freeze_approve ${userId}`)
      .text("✅ Ignore", `freeze_ignore ${userId}`);

    await bot.api.sendMessage(
      channel,
      `${pe("⚠️")} <b># FREEZE REQUEST #anticheat</b>\n\n` +
        `<blockquote>${pe("👤")} ${escHtml(mention)}\n` +
        `🆔 <code>${userId}</code>\n` +
        `${pe("📌")} Reason: ${escHtml(reason)}</blockquote>\n\n` +
        `Approve to freeze this user, or ignore to let them continue.`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch {
    // Logs channel may not be configured
  }
}

/**
 * Freeze a user — their score events are blocked.
 * Records in Redis and DB (frozen_users table).
 * Owner is never frozen.
 */
export async function freezeUser(userId: string, reason: string): Promise<void> {
  if (env.ADMIN_USERS.includes(parseInt(userId))) return;

  const frozenKey = `frozen:${userId}`;
  const alreadyFrozen = await redis.get(frozenKey);
  if (alreadyFrozen) return;

  const data = { userId, reason, frozenAt: Date.now() };
  await redis.set(frozenKey, JSON.stringify(data));

  // Update in-memory cache immediately so the freeze takes effect on the
  // current dyno without waiting for the next Redis read.
  memCache.set(`frozen:${userId}`, true, 60 * 60_000); // 60 min in-memory

  try {
    await db
      .insertInto("frozenUsers")
      .values({ userId, reason })
      .onConflict((oc) => oc.column("userId").doNothing())
      .execute();
  } catch {
    // Table may not exist yet
  }

  // Notify via anticheat logs channel
  try {
    const channel = env.ANTICHEAT_LOGS_CHANNEL || env.LOGS_CHANNEL;
    if (channel) {
      const user = await db
        .selectFrom("users")
        .select(["name", "username"])
        .where("id", "=", userId)
        .executeTakeFirst();

      const mention = user?.username ? `@${user.username}` : user?.name ?? userId;

      await bot.api.sendMessage(
        channel,
        `${pe("🧊")} <b># USER FROZEN #freeze</b>\n\n` +
          `<blockquote>${pe("👤")} ${escHtml(mention)}\n` +
          `🆔 <code>${userId}</code>\n` +
          `${pe("📌")} Reason: ${escHtml(reason)}</blockquote>\n\n` +
          `Use /unfreeze ${userId} to unfreeze.`,
        { parse_mode: "HTML" },
      );
    }
  } catch {}

  // Notify user via DM
  try {
    await bot.api.sendMessage(
      parseInt(userId),
      `${pe("🧊")} <b>Your Score Has Been Frozen</b>\n\n` +
        `<blockquote>Our anti-cheat system has detected unusual activity and an admin has frozen your account.\n` +
        `Your scoring has been temporarily suspended.\n\n` +
        `${pe("📌")} Reason: ${escHtml(reason)}\n\n` +
        `If you believe this is a mistake, please contact the owner.</blockquote>`,
      { parse_mode: "HTML" },
    );
  } catch {}
}

/**
 * Three-layer frozen check: in-memory → Redis.
 * Called on every correct guess — in-memory layer makes it instant.
 */
export async function isUserFrozen(userId: string): Promise<boolean> {
  if (env.ADMIN_USERS.includes(parseInt(userId))) return false;

  // ── Layer 1: in-process memory (0 ms) ───────────────────────────────────
  const memKey = `frozen:${userId}`;
  const memVal = memCache.get<boolean>(memKey);
  if (memVal !== undefined) return memVal;

  // ── Layer 2: Redis (1–3 ms) ──────────────────────────────────────────────
  const raw = await redis.get(`frozen:${userId}`);
  const result = !!raw;
  // 30s in-memory: short enough that an owner unfreeze takes effect quickly
  memCache.set(memKey, result, 30_000);
  return result;
}

/**
 * Unfreeze a user — clears Redis, DB, and in-memory cache.
 */
export async function unfreezeUser(userId: string): Promise<void> {
  // Clear all three layers
  memCache.del(`frozen:${userId}`);
  await redis.del(`frozen:${userId}`);
  await redis.del(`anticheat:events:${userId}`);
  await redis.del(`freeze_req:${userId}`);

  try {
    await db.deleteFrom("frozenUsers").where("userId", "=", userId).execute();
  } catch {}
}

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
