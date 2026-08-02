/**
 * /wban @username|userid [reason]  — Ban a user from playing (owner/admin, anywhere)
 * /ban  @username|userid [reason]  — Alias with confirmation step to avoid accidental bans
 *
 * Works in private DM, groups, or anywhere.
 * NOTE: Owners (ADMIN_USERS) can NEVER be banned — no matter what.
 *
 * Why /wban prefix: prevents conflict with other bots in the same group that
 * also handle /ban — using /wban makes it clear this command targets WordSeek.
 */

import { Composer, InlineKeyboard } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { isBotAdmin, invalidateBanCache } from "../util/guards";
import { OWNER_LINK, pe } from "../config/constants";
import { redis } from "../config/redis";

const composer = new Composer();

async function executeBan(
  ctx: Parameters<Parameters<typeof composer.command>[1]>[0],
  targetIdentifier: string,
  reason: string,
): Promise<void> {
  const isUsername = targetIdentifier.startsWith("@");

  const user = await db
    .selectFrom("users")
    .selectAll()
    .where(
      isUsername ? "username" : "id",
      "=",
      isUsername ? targetIdentifier.substring(1) : targetIdentifier,
    )
    .executeTakeFirst();

  if (!user) {
    await ctx.reply(
      `${pe("❌")} Can't find the user. They must have started the bot at least once.`,
    );
    return;
  }

  // ── OWNER PROTECTION: Never ban owners ───────────────────────────────────
  if (env.ADMIN_USERS.includes(parseInt(user.id))) {
    await ctx.reply(
      `${pe("⛔")} <b>Action Denied</b>\n\nYou cannot ban the bot owner.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const existingBan = await db
    .selectFrom("bannedUsers")
    .selectAll()
    .where("userId", "=", user.id)
    .executeTakeFirst();

  if (existingBan) {
    await ctx.reply(
      `${pe("⚠️")} ${escHtml(user.name)} is already banned.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await db.insertInto("bannedUsers").values({ userId: user.id }).execute();
  await invalidateBanCache(user.id);

  const adminMention = ctx.from!.username
    ? `@${ctx.from!.username}`
    : `<a href="tg://user?id=${ctx.from!.id}">${escHtml(ctx.from!.first_name)}</a>`;

  await ctx.reply(
    `${pe("🚫")} <b>User Banned from WordSeek</b>\n\n` +
      `<blockquote>${pe("👤")} User: ${escHtml(user.name)}${user.username ? ` (@${user.username})` : ""}\n` +
      `${pe("🆔")} ID: <code>${user.id}</code>\n` +
      `${pe("📌")} Reason: ${escHtml(reason)}\n` +
      `${pe("👮")} By: ${adminMention}</blockquote>`,
    { parse_mode: "HTML" },
  );

  // Notify the banned user via DM
  try {
    const kb = new InlineKeyboard().url("📩 Contact Owner", OWNER_LINK);
    await ctx.api.sendMessage(
      Number(user.id),
      `${pe("🚫")} <b>You Have Been Banned from WordSeek</b>\n\n` +
        `<blockquote>${pe("📌")} Reason: ${escHtml(reason)}\n\n` +
        `You can no longer play WordSeek.\n` +
        `If you believe this is a mistake, contact the owner.</blockquote>`,
      { parse_mode: "HTML", reply_markup: kb },
    );
  } catch {
    // User may have blocked the bot
  }
}

// ── /wban — primary command (no confirm needed) ───────────────────────────────

composer.command("wban", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply("Usage: <code>/wban @username|userid [reason]</code>", {
      parse_mode: "HTML",
    });
  }

  const parts = identifier.split(/\s+/);
  const target = parts[0];
  const reason = parts.slice(1).join(" ") || "No reason provided";

  await executeBan(ctx, target, reason);
});

// ── /ban — alias with confirmation step to avoid accidental bans ──────────────
// When someone types /ban in a group, OTHER bots may respond first.
// This bot shows a confirm dialog so you don't accidentally ban the wrong person.

composer.command("ban", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply(
      `Usage: <code>/wban @username|userid [reason]</code>\n\n<i>Tip: Use /wban to avoid conflicts with other bots.</i>`,
      { parse_mode: "HTML" },
    );
  }

  const parts = identifier.split(/\s+/);
  const target = parts[0];
  const reason = parts.slice(1).join(" ") || "No reason provided";

  // Store pending ban in Redis for 60 seconds
  const pendingKey = `pending_ban:${ctx.from.id}`;
  await redis.set(pendingKey, JSON.stringify({ target, reason }), "EX", 60);

  const kb = new InlineKeyboard()
    .text(`✅ Yes, ban ${target} from WordSeek`, `confirm_ban_${ctx.from.id}`)
    .row()
    .text("❌ Cancel", `cancel_ban_${ctx.from.id}`);

  await ctx.reply(
    `${pe("⚠️")} <b>Confirm WordSeek Ban</b>\n\n` +
      `<blockquote>Are you sure you want to ban <b>${escHtml(target)}</b> from playing WordSeek?\n\n` +
      `Reason: ${escHtml(reason)}\n\n` +
      `<i>Tip: Use /wban to skip this confirmation next time.</i></blockquote>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { executeBan };
export const banCommand = composer;
