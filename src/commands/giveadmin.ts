/**
 * /giveadmin @user|userid  — Grant bot-admin rights (owner only)
 * /removeadmin @user|userid — Revoke bot-admin rights (owner only)
 * /adminlist               — List all DB-granted bot admins
 */

import { Composer, InlineKeyboard } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

composer.command("giveadmin", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  let targetUserId: string | null = null;
  let targetName: string | null = null;
  let targetUsername: string | null = null;

  const replyUser = ctx.message?.reply_to_message?.from;
  if (replyUser && !replyUser.is_bot) {
    targetUserId = replyUser.id.toString();
    targetName =
      replyUser.first_name +
      (replyUser.last_name ? " " + replyUser.last_name : "");
    targetUsername = replyUser.username ?? null;
  } else if (ctx.match.trim()) {
    const identifier = ctx.match.trim();
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

    if (!user) {
      return ctx.reply(
        `${pe("❌")} User not found: <code>${escHtml(identifier)}</code>`,
        { parse_mode: "HTML" },
      );
    }
    targetUserId = user.id;
    targetName = user.name;
    targetUsername = user.username ?? null;
  } else {
    return ctx.reply(
      "Usage:\n• <code>/giveadmin @username</code>\n• Reply to a user's message with <code>/giveadmin</code>",
      { parse_mode: "HTML" },
    );
  }

  // Prevent granting to existing admin
  const existing = await db
    .selectFrom("botAdmins")
    .selectAll()
    .where("userId", "=", targetUserId)
    .executeTakeFirst();

  if (existing) {
    return ctx.reply(
      `${pe("⚠️")} ${escHtml(targetName!)} is already a bot admin.`,
      { parse_mode: "HTML" },
    );
  }

  const confirmKey = `giveadmin_confirm:${targetUserId}`;
  await redis.set(
    confirmKey,
    JSON.stringify({
      targetUserId,
      targetName,
      targetUsername,
      grantedBy: ctx.from.id.toString(),
    }),
    "EX",
    300,
  );

  const mention = targetUsername
    ? `@${targetUsername}`
    : `<a href="tg://user?id=${targetUserId}">${escHtml(targetName!)}</a>`;

  const kb = new InlineKeyboard()
    .text("✅ Yes, Grant Admin", `giveadmin_confirm ${targetUserId}`)
    .text("❌ Cancel", `giveadmin_cancel ${targetUserId}`);

  await ctx.reply(
    `${pe("👑")} <b>Grant Bot Admin?</b>\n\n` +
      `<blockquote>User: ${mention}\n` +
      `${pe("🆔")} ID: <code>${targetUserId}</code>\n\n` +
      `This user will get access to bot admin commands\n(ban, unban, addscore, etc.)</blockquote>`,
    { parse_mode: "HTML", reply_markup: kb },
  );
});

composer.command("removeadmin", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const identifier = ctx.match.trim();
  if (!identifier) {
    return ctx.reply(
      "Usage: <code>/removeadmin @username|userid</code>",
      { parse_mode: "HTML" },
    );
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

  if (!user) return ctx.reply(`${pe("❌")} User not found.`);

  const existing = await db
    .selectFrom("botAdmins")
    .selectAll()
    .where("userId", "=", user.id)
    .executeTakeFirst();

  if (!existing) {
    return ctx.reply(
      `${pe("⚠️")} ${escHtml(user.name)} is not a bot admin.`,
      { parse_mode: "HTML" },
    );
  }

  await db.deleteFrom("botAdmins").where("userId", "=", user.id).execute();

  return ctx.reply(
    `${pe("✅")} <b>Bot Admin Revoked</b>\n\n` +
      `<blockquote>${pe("👤")} ${escHtml(user.name)}${user.username ? ` (@${user.username})` : ""}\n` +
      `${pe("🆔")} <code>${user.id}</code></blockquote>`,
    { parse_mode: "HTML" },
  );
});

composer.command("adminlist", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const admins = await db
    .selectFrom("botAdmins")
    .innerJoin("users", "users.id", "botAdmins.userId")
    .select([
      "botAdmins.userId",
      "users.name",
      "users.username",
      "botAdmins.createdAt",
    ])
    .orderBy("botAdmins.createdAt", "asc")
    .execute();

  if (admins.length === 0) {
    return ctx.reply(`${pe("📋")} No bot admins added yet.\n\nUse /giveadmin to add one.`);
  }

  let msg = `${pe("👑")} <b>Bot Admins (${admins.length})</b>\n\n`;
  for (const [i, admin] of admins.entries()) {
    msg += `${i + 1}. ${escHtml(admin.name)}${admin.username ? ` (@${admin.username})` : ""}\n`;
    msg += `   ${pe("🆔")} <code>${admin.userId}</code>\n`;
  }
  msg += `\n<i>Owner-level admins (env ADMIN_USERS) are not listed here.</i>`;

  return ctx.reply(msg, { parse_mode: "HTML" });
});

CommandsHelper.addNewCommand("giveadmin", "Grant bot-admin rights to a user (owner only)", true);
CommandsHelper.addNewCommand("removeadmin", "Revoke bot-admin rights from a user (owner only)", true);
CommandsHelper.addNewCommand("adminlist", "List all bot admins (owner only)", true);

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const giveAdminCommand = composer;
