import { Composer } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { bot } from "../config/bot";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { getGeneralKeyboard } from "../util/get-general-keyboard";
import { addNameFromGroup } from "../services/bot-mode";

const composer = new Composer();

composer.on("my_chat_member", async (ctx) => {
  const { old_chat_member, new_chat_member, chat, from } = ctx.myChatMember;

  if (chat.type === "channel") return;

  if (
    old_chat_member.status === "left" &&
    (new_chat_member.status === "member" ||
      new_chat_member.status === "administrator")
  ) {
    if (chat.type === "group" || chat.type === "supergroup") {

      // ── Fix 5: Detailed log to LOGS_CHANNEL ─────────────────────────────
      const logsChannel = env.LOGS_CHANNEL;
      if (logsChannel) {
        try {
          const isAdmin = new_chat_member.status === "administrator";
          const addedBy = from.username
            ? `@${from.username}`
            : `${from.first_name}${from.last_name ? " " + from.last_name : ""}`;
          const chatLink = chat.username ? `@${chat.username}` : `<i>No username</i>`;
          const chatType = chat.type === "supergroup" ? "Supergroup" : "Group";

          // Try to get member count
          let memberCount = "Unknown";
          try {
            const count = await ctx.api.getChatMemberCount(chat.id);
            memberCount = count.toString();
          } catch {}

          // Try to get admin names for bot-mode user name pool
          try {
            const admins = await ctx.api.getChatAdministrators(chat.id);
            for (const admin of admins) {
              if (!admin.user.is_bot && admin.user.first_name) {
                await addNameFromGroup(
                  admin.user.first_name + (admin.user.last_name ? " " + admin.user.last_name : "")
                );
              }
            }
          } catch {}

          // Build a proper public URL for the group if it has a username
          const groupUrl = chat.username
            ? `https://t.me/${chat.username}`
            : `<i>Private group (no public link)</i>`;

          await bot.api.sendMessage(
            logsChannel,
            `${pe("🤖")} <b># BOT ADDED TO GROUP #newgroup</b>\n\n` +
              `<blockquote>` +
              `📌 <b>Group:</b> ${escHtml(chat.title)}\n` +
              `🆔 <b>Chat ID:</b> <code>${chat.id}</code>\n` +
              `🔗 <b>Username:</b> ${chatLink}\n` +
              `🌐 <b>URL:</b> ${groupUrl}\n` +
              `🏷️ <b>Type:</b> ${chatType}\n` +
              `👥 <b>Members:</b> ${memberCount}\n` +
              `👤 <b>Added by:</b> ${escHtml(addedBy)} (<code>${from.id}</code>)\n` +
              `🛡️ <b>Bot is Admin:</b> ${isAdmin ? "✅ Yes" : "❌ No"}\n` +
              `🕐 <b>Time:</b> ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC` +
              `</blockquote>\n\n` +
              `#group_${Math.abs(chat.id)} #added_by_${from.id}`,
            { parse_mode: "HTML" },
          );
        } catch {}
      }

      // ── Fix 3: Give adder a welcome score for this group ─────────────────
      try {
        const adderId = from.id.toString();
        const welcomeGroupKey = `welcome_group:${adderId}:${chat.id}`;
        const alreadyGiven = await redis.get(welcomeGroupKey);
        if (!alreadyGiven) {
          const groupScore = Math.floor(Math.random() * 496) + 5; // 5-500 pts

          // Ensure adder is in users table
          await db
            .insertInto("users")
            .values({
              id: adderId,
              name: from.first_name + (from.last_name ? " " + from.last_name : ""),
              username: from.username ?? null,
              dmStarted: true,
            })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                name: from.first_name + (from.last_name ? " " + from.last_name : ""),
                username: from.username ?? null,
              }),
            )
            .execute()
            .catch(() => {});

          // Add score for this specific group
          await db
            .insertInto("leaderboard")
            .values({
              userId: adderId,
              chatId: chat.id.toString(),
              score: groupScore,
              wordLength: "5",
            })
            .execute()
            .catch(() => {});

          await redis.set(welcomeGroupKey, "1", "EX", 86400 * 365); // Mark as given

          // Notify adder via DM
          try {
            await bot.api.sendMessage(
              from.id,
              `${pe("🎉")} <b>Thanks for adding me to your group!</b>\n\n` +
                `<blockquote>${pe("🎁")} Welcome bonus: <b>+${groupScore} pts</b> added to your score in <b>${escHtml(chat.title)}</b>!\n\n` +
                `These points are group-specific and will show on that group's leaderboard.</blockquote>\n\n` +
                `Start a game with /new in the group! ${pe("🎮")}`,
              { parse_mode: "HTML" },
            );
          } catch {}
        }
      } catch {}

      return ctx.reply(
        `<b>Thanks for adding Wordseek Bot!</b>

<blockquote>To function correctly in your group, I need permission to read messages.
Please make me an <b>administrator</b> with only the required permissions listed below.</blockquote>

<b>Required permissions:</b>
• Read all messages
• View message history

That's all I need — no other permissions are necessary.`,
        {
          parse_mode: "HTML",
          reply_markup: getGeneralKeyboard(),
        },
      );
    }
  }

  if (
    new_chat_member.status === "left" ||
    new_chat_member.status === "kicked"
  ) {
    // ── Fix 5: Log bot removal ───────────────────────────────────────────
    const logsChannel = env.LOGS_CHANNEL;
    if (logsChannel) {
      try {
        const removedBy = from.username
          ? `@${from.username}`
          : `${from.first_name}${from.last_name ? " " + from.last_name : ""}`;
        const groupTitle = (chat as any).title ?? "Unknown";
        const groupUsername = (chat as any).username;
        const groupUrl = groupUsername
          ? `https://t.me/${groupUsername}`
          : `<i>Private group (no public link)</i>`;
        const groupLink = groupUsername ? `@${groupUsername}` : `<i>No username</i>`;

        await bot.api.sendMessage(
          logsChannel,
          `${pe("🚪")} <b># BOT REMOVED FROM GROUP #botremoved</b>\n\n` +
            `<blockquote>📌 <b>Group:</b> ${escHtml(groupTitle)}\n` +
            `🆔 <b>Chat ID:</b> <code>${chat.id}</code>\n` +
            `🔗 <b>Username:</b> ${groupLink}\n` +
            `🌐 <b>URL:</b> ${groupUrl}\n` +
            `👤 <b>Removed by:</b> ${escHtml(removedBy)} (<code>${from.id}</code>)\n` +
            `🕐 <b>Time:</b> ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC</blockquote>\n\n` +
            `#group_${Math.abs(chat.id)} #removed`,
          { parse_mode: "HTML" },
        );
      } catch {}
    }

    await db
      .deleteFrom("broadcastChats")
      .where("id", "=", chat.id.toString())
      .execute()
      .catch(() => {});
  }
});

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const onBotAddedInChat = composer;
