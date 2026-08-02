import { Composer } from "grammy";
import { redis } from "../config/redis";
import { scanKeys } from "../util/scan-keys";
import { env } from "../config/env";
import { pe } from "../config/constants";

const composer = new Composer();

composer.command("track", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const chatId = ctx.match.trim();
  if (!chatId) {
    return ctx.reply("Usage: /track <chat_id>");
  }

  const trackingKey = `tracking:${chatId}`;
  const existingTracking = await redis.get(trackingKey);

  if (existingTracking) {
    return ctx.reply(`${pe("⚠️")} Chat ${chatId} is already being tracked`);
  }

  await redis.set(trackingKey, ctx.chat.id.toString());

  await ctx.reply(`${pe("✅")} Now tracking chat: ${chatId}\nAll messages will be forwarded here.`);
});

composer.command("untrack", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const chatId = ctx.match.trim();
  if (!chatId) {
    return ctx.reply("Usage: /untrack <chat_id>");
  }

  const trackingKey = `tracking:${chatId}`;
  const deleted = await redis.del(trackingKey);

  if (deleted === 0) {
    return ctx.reply(`${pe("⚠️")} Chat ${chatId} is not being tracked`);
  }

  await ctx.reply(`${pe("✅")} Stopped tracking chat: ${chatId}`);
});

composer.command("tracklist", async (ctx) => {
  if (!ctx.from || ctx.chat.type !== "private") return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  // Use scanKeys instead of redis.keys() — safe for production, non-blocking.
  const keys = await scanKeys("tracking:*");

  if (keys.length === 0) {
    return ctx.reply("No chats are currently being tracked");
  }

  const trackedChats = keys.map(key => key.replace("tracking:", "")).join("\n");
  await ctx.reply(`${pe("📋")} Currently tracking:\n${trackedChats}`);
});

export const trackCommand = composer;
