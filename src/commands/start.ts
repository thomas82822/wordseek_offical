import { Composer, InlineKeyboard, InputFile } from "grammy";

import { createReadStream } from "fs";
import { existsSync } from "fs";

import { db } from "../config/db";
import { CommandsHelper } from "../util/commands-helper";
import {
  DISCUSSION_GROUP,
  UPDATES_CHANNEL,
  randomPremiumEmoji,
  pe,
} from "../config/constants";
import { redis } from "../config/redis";

const composer = new Composer();

composer.command("start", async (ctx) => {
  // ── DM verification ──────────────────────────────────────────────────
  if (ctx.chat.type === "private" && ctx.from) {
    const userId = ctx.from.id.toString();
    const userName =
      ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");
    const userUsername = ctx.from.username || null;

    // Check if this is truly the first time (dmStarted was false/null)
    const existingUser = await db
      .selectFrom("users")
      .select(["dmStarted"])
      .where("id", "=", userId)
      .executeTakeFirst();

    const isFirstTime = !existingUser || !existingUser.dmStarted;

    await db
      .insertInto("users")
      .values({
        id: userId,
        name: userName,
        username: userUsername,
        dmStarted: true,
      })
      .onConflict((oc) =>
        oc
          .column("id")
          .doUpdateSet({ name: userName, username: userUsername, dmStarted: true }),
      )
      .execute()
      .catch(() => {});

    await redis.set(`dm_verified:${userId}`, "1", "EX", 1800).catch(() => {});

    // ── Fix 3: Welcome score for first-time users ────────────────────────
    if (isFirstTime) {
      const welcomeKey = `welcome_score:${userId}`;
      const alreadyGiven = await redis.get(welcomeKey);

      if (!alreadyGiven) {
        const welcomeScore = Math.floor(Math.random() * 991) + 10; // 10–1000 pts
        const welcomeWordLength = ["4", "5", "6"][Math.floor(Math.random() * 3)] as "4" | "5" | "6";

        await db
          .insertInto("leaderboard")
          .values({
            userId,
            chatId: "welcome",
            score: welcomeScore,
            wordLength: welcomeWordLength,
          })
          .execute()
          .catch(() => {});

        await redis.set(welcomeKey, "1", "EX", 86400 * 365);

        // Send welcome bonus notification (after the main start message)
        setTimeout(async () => {
          try {
            await ctx.api.sendMessage(
              parseInt(userId),
              `${pe("🎁")} <b>Welcome Bonus!</b>\n\n` +
                `<blockquote>${pe("🎉")} You've received a first-time welcome bonus of <b>+${welcomeScore} pts</b>!\n\n` +
                `These points are now on your leaderboard.\n` +
                `Keep playing to earn more! ${pe("🔥")}</blockquote>`,
              { parse_mode: "HTML" },
            );
          } catch {}
        }, 1500);
      }
    }
  }

  // ── Promo deep-link reward ───────────────────────────────────────────────
  if (ctx.chat.type === "private" && ctx.from) {
    const payload = ctx.match?.trim() ?? "";
    if (payload === "promo") {
      const promoKey = `promo_reward:${ctx.from.id}`;
      const alreadyClaimed = await redis.get(promoKey);
      if (!alreadyClaimed) {
        const promoReward = 50 + Math.floor(Math.random() * 151); // 50–200 pts
        await db.insertInto("leaderboard")
          .values({ userId: ctx.from.id.toString(), chatId: "promo", score: promoReward, wordLength: "5" })
          .execute().catch(() => {});
        await redis.set(promoKey, "1", "EX", 86400);
        setTimeout(async () => {
          try {
            await ctx.api.sendMessage(
              ctx.from!.id,
              `${pe("🎁")} <b>Welcome Bonus from Promo!</b>\n\n` +
                `<blockquote>You joined via our promo link and got <b>+${promoReward} pts</b> added to your leaderboard!\n` +
                `Keep playing to earn more. ${pe("🔥")}</blockquote>`,
              { parse_mode: "HTML" },
            );
          } catch {}
        }, 1200);
      }
    }
  }

  const keyboard = new InlineKeyboard()
    .url(
      "➕ Add me to your Group",
      `https://t.me/${ctx.me.username}?startgroup=true`,
    )
    .row()
    .url("📢 Updates", UPDATES_CHANNEL)
    .text("❓ Help", "help_howto")
    .url("💬 Discussion", DISCUSSION_GROUP);

  const caption = `<b>Welcome to Wordseek Bot!</b> ${randomPremiumEmoji()}

A fun and competitive Wordle-style game that you can play directly on Telegram.

<blockquote><b>Quick Start:</b>
• Use /new to start a new game
• Add me to a group with admin permissions to play with friends
• Use /help for detailed instructions and command list</blockquote>

Ready to test your word skills? Let's play! ${randomPremiumEmoji()}`;

  const customBannerId = await redis.get("bot:banner_file_id").catch(() => null);

  try {
    if (customBannerId) {
      await ctx.replyWithPhoto(customBannerId, {
        caption,
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } else if (existsSync("./src/data/banner.png")) {
      await ctx.replyWithPhoto(
        new InputFile(createReadStream("./src/data/banner.png")),
        {
          caption,
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
      );
    } else {
      await ctx.reply(caption, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch {
    await ctx.reply(caption, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
});

CommandsHelper.addNewCommand("start", "Start the bot");

export const startCommand = composer;
