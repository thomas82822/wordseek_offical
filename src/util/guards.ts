import { Context } from "grammy";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { scanKeys } from "../util/scan-keys";
import { memCache } from "../config/cache";
import { env } from "../config/env";

export async function isBotAdmin(userId: string | number): Promise<boolean> {
  const id = Number(userId);
  if (env.ADMIN_USERS.includes(id)) return true;

  // ── Layer 1: in-process memory (0 ms) ───────────────────────────────────
  const memKey = `admin:${userId}`;
  const memVal = memCache.get<boolean>(memKey);
  if (memVal !== undefined) return memVal;

  // ── Layer 2: Redis (1–3 ms) ──────────────────────────────────────────────
  const cacheKey = `admin_check:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const result = cached === "1";
      memCache.set(memKey, result, 5 * 60_000); // 5 min in-memory
      return result;
    }
  } catch {}

  // ── Layer 3: DB (10–50 ms) ───────────────────────────────────────────────
  const admin = await db
    .selectFrom("botAdmins")
    .select("userId")
    .where("userId", "=", String(userId))
    .executeTakeFirst();

  const result = !!admin;
  memCache.set(memKey, result, 5 * 60_000);
  redis.set(cacheKey, result ? "1" : "0", "EX", 600).catch(() => {}); // 10 min Redis
  return result;
}

/** Call after giveadmin / removeadmin to keep all cache layers fresh. */
export async function invalidateAdminCache(userId: string): Promise<void> {
  memCache.del(`admin:${userId}`);
  try {
    await redis.del(`admin_check:${userId}`);
  } catch {}
}

type GuardResult = { ok: true } | { ok: false; message: string };

export async function requireAllowedTopic(ctx: Context): Promise<GuardResult> {
  if (!ctx.chat || ctx.chat.type === "private") return { ok: true };

  const chatId = ctx.chat.id.toString();
  const currentTopicId = (ctx as any).msg?.message_thread_id?.toString() ?? "general";

  // ── Layer 1: in-process memory (0 ms) ───────────────────────────────────
  const memKey = `topic:${chatId}:${currentTopicId}`;
  const memVal = memCache.get<boolean>(memKey);
  if (memVal !== undefined) {
    return memVal
      ? { ok: true }
      : { ok: false, message: "This command isn't allowed in this topic." };
  }

  // ── Layer 2: Redis (1–3 ms) ──────────────────────────────────────────────
  const cacheKey = `topic_allowed:${chatId}:${currentTopicId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const allowed = cached === "1";
      memCache.set(memKey, allowed, 2 * 60_000); // 2 min in-memory
      return allowed
        ? { ok: true }
        : { ok: false, message: "This command isn't allowed in this topic." };
    }
  } catch {}

  // ── Layer 3: DB (10–50 ms) ───────────────────────────────────────────────
  const configuredTopics = await db
    .selectFrom("chatGameTopics")
    .selectAll()
    .where("chatId", "=", chatId)
    .execute();

  const allowed =
    configuredTopics.length === 0 ||
    configuredTopics.some((t) => t.topicId === currentTopicId);

  memCache.set(memKey, allowed, 2 * 60_000);
  redis.set(cacheKey, allowed ? "1" : "0", "EX", 300).catch(() => {});
  return allowed
    ? { ok: true }
    : { ok: false, message: "This command isn't allowed in this topic." };
}

/** Call when topic settings change so all cache layers are refreshed. */
export async function invalidateTopicCache(chatId: string): Promise<void> {
  memCache.delPrefix(`topic:${chatId}:`);
  try {
    // Use scanKeys instead of redis.keys() — safe for production, non-blocking.
    const keys = await scanKeys(`topic_allowed:${chatId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {}
}

async function requireBotAdmin(ctx: Context): Promise<GuardResult> {
  if (!ctx.from) return { ok: false, message: "Could not identify user." };
  const admin = await isBotAdmin(ctx.from.id);
  return admin
    ? { ok: true }
    : { ok: false, message: "⛔ This command is for admins only." };
}

async function requireNotBanned(ctx: Context): Promise<GuardResult> {
  if (!ctx.from) return { ok: false, message: "Could not identify user." };
  const banned = await isUserBanned(ctx.from.id.toString());
  return banned
    ? { ok: false, message: "🚫 You are banned from using WordSeek." }
    : { ok: true };
}

type GuardFn = (ctx: Context) => Promise<GuardResult>;

export async function runGuards(
  ctx: Context,
  guards: GuardFn[],
): Promise<GuardResult> {
  for (const guard of guards) {
    const result = await guard(ctx);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Run all guards in PARALLEL instead of sequentially.
 * Use when guards are fully independent (no side effects, read-only checks).
 *
 * Example: requireNotBanned + requireAllowedTopic are both pure Redis/DB
 * reads — running them in parallel cuts latency from (A + B) to max(A, B).
 */
export async function runGuardsParallel(
  ctx: Context,
  guards: GuardFn[],
): Promise<GuardResult> {
  const results = await Promise.all(guards.map((g) => g(ctx)));
  return results.find((r) => !r.ok) ?? { ok: true };
}

/**
 * Three-layer ban check: in-memory → Redis → DB.
 * Hot path: checked on EVERY group message, so in-memory matters a lot.
 * Stale window: 2 min. A fresh ban takes effect within 2 min without any DB hit.
 */
export async function isUserBanned(userId: string): Promise<boolean> {
  // ── Layer 1: in-process memory (0 ms) ───────────────────────────────────
  const memKey = `banned:${userId}`;
  const memVal = memCache.get<boolean>(memKey);
  if (memVal !== undefined) return memVal;

  // ── Layer 2: Redis (1–3 ms) ──────────────────────────────────────────────
  const cacheKey = `banned_check:${userId}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const result = cached === "1";
      memCache.set(memKey, result, 2 * 60_000); // 2 min in-memory
      return result;
    }
  } catch {}

  // ── Layer 3: DB (10–50 ms) ───────────────────────────────────────────────
  const banned = await db
    .selectFrom("bannedUsers")
    .select("userId")
    .where("userId", "=", userId)
    .executeTakeFirst();

  const result = !!banned;
  memCache.set(memKey, result, 2 * 60_000);
  redis.set(cacheKey, result ? "1" : "0", "EX", 300).catch(() => {});
  return result;
}

/**
 * Invalidate the ban cache for a user — call this after ban/unban.
 * Clears both in-memory and Redis layers so the change takes effect immediately.
 */
export async function invalidateBanCache(userId: string): Promise<void> {
  memCache.del(`banned:${userId}`);
  try {
    await redis.del(`banned_check:${userId}`);
  } catch {}
}

export const regularGameGuards: GuardFn[] = [requireNotBanned, requireAllowedTopic];
export const dailyGameGuards: GuardFn[] = [requireNotBanned];
export const adminOnlyGuards: GuardFn[] = [requireBotAdmin];
