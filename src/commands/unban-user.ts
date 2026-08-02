/**
 * /wunban @username|userid  — Unban a previously banned user (owner/admin only)
 * /unban  @username|userid  — Alias with confirmation step
 *
 * Why /wunban prefix: prevents conflict with other bots in the same group.
 */

import { Composer, InlineKeyboard } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { isBotAdmin, invalidateBanCache } from "../util/guards";
import { redis } from "../config/redis";

const composer = new Composer();

async function executeUnban(
  ctx: Parameters<Parameters<typeof composer.command>[1]>[0],
  targetIdentifier: string,
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

  const existingBan = await db
    .selectFrom("bannedUsers")
    .selectAll()
    .where("userId", "=", user.id)
    .executeTakeFirst();

  if (!existingBan) {
    await ctx.reply(
      `${pe("⚠️")} ${escHtml(user.name)} is not banned.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await db.deleteFrom("bannedUsers").where("userId", "=", user.id).execute();
  await invalidateBanCache(user.id);

  const adminMention = ctx.from!.username
    ? `@${ctx.from!.username}`
    : `<a href="tg://user?id=${ctx.from!.id}">${escHtml(ctx.from!.first_name)}</a>`;

  await ctx.reply(
    `${pe("✅")} <b>User Unbanned from WordSeek</b>\n\n` +
      `<blockquote>${pe("👤")} User: ${escHtml(user.name)}${user.username ? ` (@${user.username})` : ""}\n` +
      `${pe("🆔")} ID: <code>${user.id}</code>\n` +
      `${pe("👮")} By: ${adminMention}</blockquote>`,
    { parse_mode: "HTML" },
  );

  // Notify user
  try {
    await ctx.api.sendMessage(
      Number(user.id),
      `${pe("✅")} <b>You Have Been Unbanned from WordSeek!</b>\n\n` +
        `You can now play WordSeek again. Enjoy! ${pe("🎮")}`,
      { parse_mode: "HTML" },
    );
  } catch {
    // User may have blocked the bot
  }
}

// ── /wunban — primary command (no confirm needed) ─────────────────────────────

composer.command("wunban", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply("Usage: <code>/wunban @username|userid</code>", {
      parse_mode: "HTML",
    });
  }

  const parts = identifier.split(/\s+/);
  const target = parts[0];

  await executeUnban(ctx, target);
});

// ── /unban — alias with confirmation step ─────────────────────────────────────

composer.command("unban", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply(
      `Usage: <code>/wunban @username|userid</code>\n\n<i>Tip: Use /wunban to avoid conflicts with other bots.</i>`,
      { parse_mode: "HTML" },
    );
  }

  const parts = identifier.split(/\s+/);
  const target = parts[0];

  // Store pending unban in Redis for 60 seconds
  const pendingKey = `pending_unban:${ctx.from.id}`;
  await redis.set(pendingKey, JSON.stringify({ target }), "EX", 60);

  const kb = new InlineKeyboard()
    .text(`✅ Yes, unban ${target} from WordSeek`, `confirm_unban_${ctx.from.id}`)
    .row()
    .text("❌ Cancel", `cancel_unban_${ctx.from.id}`);

  await ctx.reply(
    `${pe("⚠️")} <b>Confirm WordSeek Unban</b>\n\n` +
      `<blockquote>Are you sure you want to unban <b>${escHtml(target)}</b> from WordSeek?\n\n` +
      `<i>Tip: Use /wunban to skip this confirmation next time.</i></blockquote>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export { executeUnban };
export const unbanCommand = composer;
