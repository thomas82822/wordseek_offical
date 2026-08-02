/**
 * /requesttransfer <old_account> <new_account>
 * User-facing score transfer request. Creates a pending request and notifies the owner.
 */

import { Composer } from "grammy";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";
import { logTransferRequest } from "../services/logging";

const composer = new Composer();

composer.command("requesttransfer", async (ctx) => {
  // Ignore bot accounts
  if (!ctx.from || ctx.from.is_bot) return;

  const args = ctx.match.trim().split(/\s+/).filter(Boolean);
  if (args.length !== 2) {
    return ctx.reply(
      `${pe("📤")} <b>Score Transfer Request</b>\n\n` +
        "Usage: <code>/requesttransfer &lt;old_account&gt; &lt;new_account&gt;</code>\n\n" +
        "Examples:\n" +
        "• <code>/requesttransfer @OldUsername @NewUsername</code>\n" +
        "• <code>/requesttransfer 123456789 987654321</code>\n\n" +
        "<i>The owner will review and approve your request.</i>",
      { parse_mode: "HTML" },
    );
  }

  const [fromIdentifier, toIdentifier] = args;

  // Early check: same identifier string (prevents unnecessary DB lookups)
  if (fromIdentifier.toLowerCase() === toIdentifier.toLowerCase()) {
    return ctx.reply(`${pe("❌")} Cannot transfer to the same account.`);
  }

  const getUser = async (identifier: string) => {
    const isUsername = identifier.startsWith("@");
    return await db
      .selectFrom("users")
      .selectAll()
      .where(
        isUsername ? "username" : "id",
        "=",
        isUsername ? identifier.substring(1) : identifier,
      )
      .executeTakeFirst();
  };

  const fromUser = await getUser(fromIdentifier);
  const toUser = await getUser(toIdentifier);

  if (!fromUser) {
    return ctx.reply(
      `${pe("❌")} Old account not found: <code>${escHtml(fromIdentifier)}</code>\n<i>The account must have played at least one game.</i>`,
      { parse_mode: "HTML" },
    );
  }
  if (!toUser) {
    return ctx.reply(
      `${pe("❌")} New account not found: <code>${escHtml(toIdentifier)}</code>\n<i>The account must have started the bot at least once.</i>`,
      { parse_mode: "HTML" },
    );
  }
  if (fromUser.id === toUser.id) {
    return ctx.reply(`${pe("❌")} Cannot transfer to the same account.`);
  }

  const cooldownKey = `transfer_request:${ctx.from.id}`;
  const existing = await redis.get(cooldownKey);
  if (existing) {
    return ctx.reply(
      `${pe("⏳")} You already have a pending transfer request today.\nPlease wait for the owner to review it.`,
    );
  }

  const scoreRows = await db
    .selectFrom("leaderboard")
    .where("userId", "=", fromUser.id)
    .select(db.fn.sum<number>("score").as("total"))
    .executeTakeFirst();

  const totalScore = Number(scoreRows?.total ?? 0);
  const requestId = Date.now();

  await redis.set(
    `transfer_req:${requestId}`,
    JSON.stringify({
      requestId,
      fromUserId: fromUser.id,
      toUserId: toUser.id,
      requesterId: ctx.from.id.toString(),
      createdAt: Date.now(),
    }),
    "EX",
    86400 * 7,
  );

  await redis.set(cooldownKey, "1", "EX", 86400);

  await logTransferRequest({
    requestId,
    fromUser: {
      id: fromUser.id,
      name: fromUser.name,
      username: fromUser.username,
    },
    toUser: { id: toUser.id, name: toUser.name, username: toUser.username },
    totalScore,
  });

  const fromMention = fromUser.username
    ? `@${fromUser.username}`
    : fromUser.name;
  const toMention = toUser.username ? `@${toUser.username}` : toUser.name;

  // "Requested from" — identity of whoever sent this command
  const requesterMention = ctx.from.username
    ? `@${ctx.from.username}`
    : ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");

  await ctx.reply(
    `${pe("✅")} <b>Transfer Request Submitted!</b>\n\n` +
      `<blockquote>${pe("📤")} From: ${escHtml(fromMention)} (<code>${fromUser.id}</code>)\n` +
      `${pe("📥")} To: ${escHtml(toMention)} (<code>${toUser.id}</code>)\n` +
      `${pe("👤")} Requested From: ${escHtml(requesterMention)} (<code>${ctx.from.id}</code>)\n` +
      `${pe("💯")} Score to Transfer: <code>${totalScore.toLocaleString()}</code>\n` +
      `${pe("🆔")} Request ID: <code>${requestId}</code></blockquote>\n\n` +
      `<i>The owner will review your request. You'll be notified once it's approved or rejected.</i>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand(
  "requesttransfer",
  "Request a score transfer from old account to new account",
);

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const requestTransferCommand = composer;
