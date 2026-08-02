/**
 * /unfreeze <userid|@username>  — Owner/Admin: unfreeze a frozen user.
 * /freezelist                   — Owner/Admin: list all frozen users.
 */

import { Composer } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { scanKeys } from "../util/scan-keys";
import { isBotAdmin } from "../util/guards";
import { unfreezeUser, isUserFrozen } from "../services/anticheat";

const composer = new Composer();

composer.command("unfreeze", async (ctx) => {
  if (!ctx.from) return;
  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply("Usage: <code>/unfreeze @username|userid</code>", {
      parse_mode: "HTML",
    });
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

  if (!user) return ctx.reply("❌ User not found.");

  const frozen = await isUserFrozen(user.id);
  if (!frozen) {
    return ctx.reply(
      `ℹ️ ${escHtml(user.name)} is not currently frozen.`,
      { parse_mode: "HTML" },
    );
  }

  await unfreezeUser(user.id);

  const mention = user.username
    ? `@${user.username}`
    : escHtml(user.name);

  await ctx.reply(
    `✅ <b>User Unfrozen</b>\n\n` +
      `<blockquote>👤 ${mention}\n🆔 <code>${user.id}</code>\n\nThey can now play and earn score normally.</blockquote>`,
    { parse_mode: "HTML" },
  );

  // Notify user if possible
  try {
    await ctx.api.sendMessage(
      Number(user.id),
      `✅ Your score has been <b>unfrozen</b> by an admin.\nYou can now play and earn points normally!\n\nSorry for the inconvenience. 🎮`,
      { parse_mode: "HTML" },
    );
  } catch {}
});

composer.command("freezelist", async (ctx) => {
  if (!ctx.from) return;
  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  // Use scanKeys instead of redis.keys() — safe for production, non-blocking.
  const keys = await scanKeys("frozen:*");
  if (keys.length === 0) {
    return ctx.reply("✅ No users are currently frozen.");
  }

  const lines: string[] = [`🧊 <b>Frozen Users (${keys.length})</b>\n`];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      const user = await db
        .selectFrom("users")
        .selectAll()
        .where("id", "=", data.userId)
        .executeTakeFirst();
      const name = user?.username
        ? `@${user.username}`
        : (user?.name ?? data.userId);
      const frozenAt = new Date(data.frozenAt)
        .toISOString()
        .substring(0, 16)
        .replace("T", " ");
      lines.push(
        `• ${escHtml(name)} (<code>${data.userId}</code>)\n` +
          `  📅 ${frozenAt} UTC\n` +
          `  📌 ${escHtml(data.reason ?? "Unknown")}`,
      );
    } catch {}
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const unfreezeCommand = composer;
