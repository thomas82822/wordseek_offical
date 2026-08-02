import { Composer, GrammyError, InlineKeyboard } from "grammy";
import { executeBan } from "../commands/ban-user";
import { executeUnban } from "../commands/unban-user";

import { sql } from "kysely";

import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { captchaSchema } from "../schemas";
import { getUserScores } from "../services/get-user-scores";
import { getSmartDefaults } from "../util/get-smart-defaults";
import { isBotAdmin } from "../util/guards";
import { endGame, isUserAuthorized } from "../commands/end-game";
import { AllowedChatSearchKey, AllowedChatTimeKey } from "../types";
import { formatNoScoresMessage } from "../util/format-no-scores-message";
import { getLeaderboardScores } from "../services/get-leaderboard-scores";
import { formatUserScoreMessage } from "../util/format-user-score-message";
import { formatLeaderboardMessage } from "../util/format-leaderboard-message";
import { generateLeaderboardKeyboard } from "../util/generate-leaderboard-keyboard";
import { generateUserSelectionKeyboard } from "../util/generate-user-selection-keyboard";
import {
  buildCaptchaKeyboard,
  buildMessage,
  formatUserMention,
} from "../commands/captcha";
import {
  AllowedWordLength,
  SLOT_SYMBOLS,
  allowedChatSearchKeys,
  allowedChatTimeKeys,
  allowedWordLengths,
} from "../config/constants";
import {
  getAdminCommandsMessage,
  getGroupSettingsMessage,
  getHowToPlayMessage,
  getMainHelpKeyboard,
  getOtherCommandsMessage,
  getScoresMessage,
} from "../commands/help";
import { pe } from "../config/constants";

const composer = new Composer();

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

composer.on("callback_query:data", async (ctx) => {
  // ── Giveadmin confirm/cancel ─────────────────────────────────────────────
  if (ctx.callbackQuery.data.startsWith("giveadmin_confirm ")) {
    const [, targetUserId] = ctx.callbackQuery.data.split(" ");
    if (!targetUserId) return ctx.answerCallbackQuery();

    // Only the owner can confirm
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "Only the bot owner can confirm this.",
        show_alert: true,
      });
    }

    const confirmKey = `giveadmin_confirm:${targetUserId}`;
    const raw = await redis.get(confirmKey);
    if (!raw) {
      return ctx.answerCallbackQuery({
        text: "This request has expired (5 min limit).",
        show_alert: true,
      });
    }

    const { targetName, targetUsername, grantedBy } = JSON.parse(raw);

    await db
      .insertInto("botAdmins")
      .values({ userId: targetUserId, grantedBy })
      .onConflict((oc) => oc.column("userId").doNothing())
      .execute();

    await redis.del(confirmKey);

    const mention = targetUsername
      ? `@${targetUsername}`
      : `<a href="tg://user?id=${targetUserId}">${escHtml(targetName)}</a>`;

    await ctx
      .editMessageText(
        `✅ <b>Bot Admin Granted!</b>\n\n` +
          `<blockquote>${pe("👤")} ${mention}\n🆔 <code>${targetUserId}</code>\n\nThey now have bot admin access.</blockquote>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});

    // Notify the new admin
    try {
      await ctx.api.sendMessage(
        parseInt(targetUserId),
        `${pe("👑")} <b>You are now a Bot Admin!</b>\n\nThe owner has granted you bot admin rights.\nYou can now use commands like /ban, /unban, /addscore, and more.`,
        { parse_mode: "HTML" },
      );
    } catch {}

    return ctx.answerCallbackQuery({ text: "Admin granted!" });
  }

  if (ctx.callbackQuery.data.startsWith("giveadmin_cancel ")) {
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "Only the bot owner can cancel this.",
        show_alert: true,
      });
    }

    const [, targetUserId] = ctx.callbackQuery.data.split(" ");
    if (targetUserId) {
      await redis.del(`giveadmin_confirm:${targetUserId}`);
    }

    await ctx
      .editMessageText("❌ <b>Admin grant cancelled.</b>", {
        parse_mode: "HTML",
      })
      .catch(() => {});

    return ctx.answerCallbackQuery({ text: "Cancelled." });
  }

  // ── Bonus approve/reject (from logs channel) ─────────────────────────────
  if (ctx.callbackQuery.data.startsWith("bonus_approve ") || ctx.callbackQuery.data.startsWith("bonus_reject ")) {
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "Only the bot owner can approve/reject.",
        show_alert: true,
      });
    }

    const [action, requestIdStr] = ctx.callbackQuery.data.split(" ");
    const requestId = parseInt(requestIdStr);

    const raw = await redis.get(`bonus_req:${requestId}`);
    if (!raw) {
      await ctx.editMessageText(
        ctx.callbackQuery.message?.text +
          "\n\n⚠️ <i>Request expired or already processed.</i>",
        { parse_mode: "HTML" },
      ).catch(() => {});
      return ctx.answerCallbackQuery({ text: "Request not found or expired." });
    }

    const req = JSON.parse(raw);

    if (action === "bonus_approve") {
      // Add bonus to leaderboard (global, any length — random 5-letter default)
      await db
        .insertInto("leaderboard")
        .values({
          userId: req.userId,
          chatId: "bonus",
          score: req.bonusScore,
          wordLength: "5",
        })
        .execute();

      await redis.del(`bonus_req:${requestId}`);

      // Notify user
      try {
        await ctx.api.sendMessage(
          parseInt(req.userId),
          `${pe("🎉")} <b>Bonus Approved!</b>\n\n` +
            `<blockquote>✨ <code>${Number(req.bonusScore).toLocaleString()}</code> pts have been added to your leaderboard!\n` +
            `🆔 Request: <code>${requestId}</code></blockquote>\n\nKeep playing and claiming! ${pe("🏆")}`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx
        .editMessageText(
          ctx.callbackQuery.message?.text +
            `\n\n✅ <b>Approved by ${escHtml(ctx.from.first_name)}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: `Bonus approved! +${req.bonusScore} pts added.` });
    } else {
      await redis.del(`bonus_req:${requestId}`);

      try {
        await ctx.api.sendMessage(
          parseInt(req.userId),
          `❌ <b>Bonus Claim Rejected</b>\n\n` +
            `<blockquote>Your bonus claim of <code>${Number(req.bonusScore).toLocaleString()}</code> pts was not approved.\n` +
            `🆔 Request: <code>${requestId}</code>\n\nYou can try again tomorrow with /claimbonus.</blockquote>`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx
        .editMessageText(
          ctx.callbackQuery.message?.text +
            `\n\n❌ <b>Rejected by ${escHtml(ctx.from.first_name)}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: "Bonus rejected." });
    }
  }

  // ── Transfer approve/reject ───────────────────────────────────────────────
  if (ctx.callbackQuery.data.startsWith("transfer_approve ") || ctx.callbackQuery.data.startsWith("transfer_reject ")) {
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "Only the bot owner can approve/reject transfers.",
        show_alert: true,
      });
    }

    const [action, requestIdStr] = ctx.callbackQuery.data.split(" ");
    const requestId = parseInt(requestIdStr);

    const raw = await redis.get(`transfer_req:${requestId}`);
    if (!raw) {
      await ctx
        .editMessageText(
          ctx.callbackQuery.message?.text +
            "\n\n⚠️ <i>Request expired or already processed.</i>",
          { parse_mode: "HTML" },
        )
        .catch(() => {});
      return ctx.answerCallbackQuery({ text: "Request not found." });
    }

    const req = JSON.parse(raw);

    if (action === "transfer_approve") {
      // Move all leaderboard rows from fromUser to toUser
      await db
        .updateTable("leaderboard")
        .set({ userId: req.toUserId })
        .where("userId", "=", req.fromUserId)
        .execute();

      await redis.del(`transfer_req:${requestId}`);

      try {
        await ctx.api.sendMessage(
          parseInt(req.requesterId),
          `✅ <b>Transfer Approved!</b>\n\nYour score has been transferred from account <code>${req.fromUserId}</code> to <code>${req.toUserId}</code>.`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx
        .editMessageText(
          ctx.callbackQuery.message?.text +
            `\n\n✅ <b>Approved by ${escHtml(ctx.from.first_name)}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: "Transfer approved!" });
    } else {
      await redis.del(`transfer_req:${requestId}`);

      try {
        await ctx.api.sendMessage(
          parseInt(req.requesterId),
          `❌ <b>Transfer Request Rejected</b>\n\nYour score transfer request was not approved. You can submit a new request tomorrow.`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx
        .editMessageText(
          ctx.callbackQuery.message?.text +
            `\n\n❌ <b>Rejected by ${escHtml(ctx.from.first_name)}</b>`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: "Transfer rejected." });
    }
  }

  // ── Fix 1: Freeze approve/ignore (from anticheat log channel) ──────────────
  if (
    ctx.callbackQuery.data.startsWith("freeze_approve ") ||
    ctx.callbackQuery.data.startsWith("freeze_ignore ")
  ) {
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({
        text: "Only the bot owner can freeze/ignore users.",
        show_alert: true,
      });
    }

    const [action, targetUserId] = ctx.callbackQuery.data.split(" ");
    if (!targetUserId) return ctx.answerCallbackQuery();

    if (action === "freeze_approve") {
      const { freezeUser } = await import("../services/anticheat");
      await freezeUser(targetUserId, "Frozen by admin via anticheat log");

      const user = await db
        .selectFrom("users")
        .select(["name", "username"])
        .where("id", "=", targetUserId)
        .executeTakeFirst();
      const mention = user?.username
        ? `@${user.username}`
        : user?.name ?? targetUserId;

      await ctx
        .editMessageText(
          (ctx.callbackQuery.message?.text ?? "") +
            `\n\n🧊 <b>Frozen by ${escHtml(ctx.from.first_name)}</b>\nUser: ${escHtml(mention)}`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: `🧊 User ${targetUserId} frozen!` });
    } else {
      // freeze_ignore — clear freeze request cooldown so it could be raised again if needed
      await redis.del(`freeze_req:${targetUserId}`);

      await ctx
        .editMessageText(
          (ctx.callbackQuery.message?.text ?? "") +
            `\n\n✅ <b>Ignored by ${escHtml(ctx.from.first_name)}</b> — user continues.`,
          { parse_mode: "HTML" },
        )
        .catch(() => {});

      return ctx.answerCallbackQuery({ text: "Ignored — user not frozen." });
    }
  }

  condition: if (ctx.callbackQuery.data.startsWith("leaderboard")) {
    const [, searchKey, timeKey, wordLength] =
      ctx.callbackQuery.data.split(" ");

    if (!allowedChatSearchKeys.includes(searchKey as AllowedChatSearchKey))
      break condition;
    if (!allowedChatTimeKeys.includes(timeKey as AllowedChatTimeKey))
      break condition;
    if (!allowedWordLengths.includes(parseInt(wordLength) as AllowedWordLength))
      break condition;
    if (!ctx.chat) break condition;

    const chatId = ctx.chat.id.toString();
    const [memberScores, viewerScore] = await Promise.all([
      getLeaderboardScores({
        chatId,
        searchKey: searchKey as AllowedChatSearchKey,
        timeKey: timeKey as AllowedChatTimeKey,
        wordLength: parseInt(wordLength) as AllowedWordLength,
      }),
      getUserScores({
        userId: ctx.from.id.toString(),
        chatId,
        searchKey: searchKey as AllowedChatSearchKey,
        timeKey: timeKey as AllowedChatTimeKey,
        wordLength: parseInt(wordLength) as AllowedWordLength,
      }),
    ]);

    const viewerRank = viewerScore
      ? {
          rank: viewerScore.rank,
          totalScore: Number(viewerScore.totalScore),
          inTopList: memberScores.some((m) => m.userId === viewerScore.id),
        }
      : null;

    const keyboard = generateLeaderboardKeyboard(
      searchKey as AllowedChatSearchKey,
      timeKey as AllowedChatTimeKey,
      parseInt(wordLength) as AllowedWordLength,
    );

    await ctx
      .editMessageText(
        formatLeaderboardMessage(
          memberScores,
          searchKey as AllowedChatSearchKey,
          viewerRank,
        ),
        {
          reply_markup: keyboard,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        },
      )
      .catch(() => {});
  } else if (ctx.callbackQuery.data.startsWith("score_list")) {
    const parts = ctx.callbackQuery.data.split(" ");

    const [, username] = parts;
    if (!username) break condition;

    const users = await db
      .selectFrom("users")
      .select(["id", "name", "username"])
      .where(sql`lower(username)`, "=", username)
      .execute();

    if (users.length === 0) {
      return ctx.answerCallbackQuery({
        text: "No users found with this username.",
        show_alert: true,
      });
    }

    const keyboard = generateUserSelectionKeyboard(users, username);

    await ctx
      .editMessageText(
        `⚠️ <strong>Multiple Users Found</strong>\n\n` +
          `There are ${users.length} users with username @${username}. ` +
          `This can happen when a user deletes their account and someone else creates a new account with the same username.\n\n` +
          `Please select the user you want to view:`,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
        },
      )
      .catch(() => {});

    return await ctx.answerCallbackQuery();
  } else if (ctx.callbackQuery.data.startsWith("score")) {
    const parts = ctx.callbackQuery.data.split(" ");

    if (ctx.callbackQuery.data.startsWith("score_select")) {
      const [, userId, username] = parts;
      if (!userId) break condition;
      if (!ctx.chat) break condition;

      const chatId = ctx.chat.id.toString();

      const userInfo = await db
        .selectFrom("users")
        .select(["name"])
        .where("id", "=", userId)
        .executeTakeFirst();

      if (!userInfo) {
        return ctx.answerCallbackQuery({
          text: "User not found.",
          show_alert: true,
        });
      }

      const { searchKey, timeKey, hasAnyScores, wordLength } =
        await getSmartDefaults({
          userId,
          chatId,
          requestedSearchKey: undefined,
          requestedTimeKey: undefined,
          chatType: ctx.chat.type,
        });

      const userScore = await getUserScores({
        chatId,
        userId,
        searchKey,
        timeKey,
      });

      if (!userScore) {
        const message = formatNoScoresMessage({
          isOwnScore: false,
          userName: userInfo.name,
          searchKey,
          timeKey,
          wasTimeKeyExplicit: false,
          hasAnyScores,
        });

        const backButtonDetails = {
          text: "⬅️ Back to user list",
          callback: `score_list ${username}`,
        };

        const keyboard = hasAnyScores
          ? generateLeaderboardKeyboard(
              searchKey,
              timeKey,
              wordLength,
              `score ${userId}`,
              username ? backButtonDetails : undefined,
            )
          : new InlineKeyboard().text(
              backButtonDetails.text,
              backButtonDetails.callback,
            );

        await ctx
          .editMessageText(message, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          })
          .catch(() => {});

        return ctx.answerCallbackQuery({
          text: "No scores found for the current filter.",
        });
      }

      const keyboard = generateLeaderboardKeyboard(
        searchKey,
        timeKey,
        wordLength,
        `score ${userId}`,
        username
          ? {
              text: "⬅️ Back to user list",
              callback: `score_list ${username}`,
            }
          : undefined,
      );

      await ctx
        .editMessageText(formatUserScoreMessage(userScore, searchKey), {
          reply_markup: keyboard,
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        })
        .catch(() => {});

      return await ctx.answerCallbackQuery();
    }
    if (
      ctx.callbackQuery.data.startsWith("score ") &&
      !ctx.callbackQuery.data.startsWith("score_select") &&
      !ctx.callbackQuery.data.startsWith("score_list")
    ) {
      const [, userId, searchKey, timeKey, wordLength] = parts;
      if (!allowedChatSearchKeys.includes(searchKey as AllowedChatSearchKey))
        break condition;
      if (!allowedChatTimeKeys.includes(timeKey as AllowedChatTimeKey))
        break condition;
      if (
        !allowedWordLengths.includes(parseInt(wordLength) as AllowedWordLength)
      )
        break condition;
      if (!ctx.chat) break condition;
      if (!userId) break condition;

      const chatId = ctx.chat.id.toString();

      const userInfo = await db
        .selectFrom("users")
        .select(["name"])
        .where("id", "=", userId)
        .executeTakeFirst();

      if (!userInfo) {
        return ctx.answerCallbackQuery({
          text: "User not found.",
          show_alert: true,
        });
      }

      let hasAnyScoresQuery = db
        .selectFrom("leaderboard")
        .select("userId")
        .where("userId", "=", userId)
        .limit(1);

      if (searchKey === "group") {
        hasAnyScoresQuery = hasAnyScoresQuery.where("chatId", "=", chatId);
      }

      const hasAnyScores = !!(await hasAnyScoresQuery.executeTakeFirst());

      const userScore = await getUserScores({
        chatId,
        userId,
        searchKey: searchKey as AllowedChatSearchKey,
        timeKey: timeKey as AllowedChatTimeKey,
        wordLength: parseInt(wordLength) as AllowedWordLength,
      });

      if (!userScore) {
        const message = formatNoScoresMessage({
          isOwnScore: userId === ctx.from?.id.toString(),
          userName: userInfo.name,
          searchKey: searchKey as AllowedChatSearchKey,
          timeKey: timeKey as AllowedChatTimeKey,
          wasTimeKeyExplicit: true,
          hasAnyScores,
        });

        const keyboard = generateLeaderboardKeyboard(
          searchKey as AllowedChatSearchKey,
          timeKey as AllowedChatTimeKey,
          parseInt(wordLength) as AllowedWordLength,
          `score ${userId}`,
        );

        await ctx
          .editMessageText(message, {
            reply_markup: keyboard,
            parse_mode: "HTML",
          })
          .catch(() => {});

        return ctx.answerCallbackQuery({
          text: "No scores found for this period.",
          show_alert: false,
        });
      }

      const keyboard = generateLeaderboardKeyboard(
        searchKey as AllowedChatSearchKey,
        timeKey as AllowedChatTimeKey,
        parseInt(wordLength) as AllowedWordLength,
        `score ${userId}`,
      );

      await ctx
        .editMessageText(
          formatUserScoreMessage(userScore, searchKey as AllowedChatSearchKey),
          {
            reply_markup: keyboard,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        )
        .catch(() => {});

      return await ctx.answerCallbackQuery();
    }
    await ctx.answerCallbackQuery();
  } else if (ctx.callbackQuery.data.startsWith("vote_end")) {
    const [, chatIdStr] = ctx.callbackQuery.data.split(" ");
    if (!chatIdStr) return;

    const chatId = parseInt(chatIdStr);

    if (!ctx.chat || ctx.chat.id !== chatId) {
      return await ctx.answerCallbackQuery({
        text: "This vote is not for this chat.",
        show_alert: true,
      });
    }

    const existingGame = await db
      .selectFrom("games")
      .selectAll()
      .where("activeChat", "=", chatId.toString())
      .executeTakeFirst();

    if (!existingGame) {
      return await ctx.answerCallbackQuery({
        text: "No active game found.",
        show_alert: true,
      });
    }

    const userId = ctx.from.id.toString();
    const voteKey = `vote:${chatId}`;
    const voteDataStr = await redis.get(voteKey);

    if (!voteDataStr) {
      return await ctx.answerCallbackQuery({
        text: "The voting session has expired.",
        show_alert: true,
      });
    }

    const voteData = JSON.parse(voteDataStr);

    if (voteData.voters.includes(userId)) {
      return await ctx.answerCallbackQuery({
        text: "You have already voted.",
      });
    }

    const chatMember = await ctx.getChatMember(parseInt(userId));
    const isAdmin =
      chatMember.status === "administrator" || chatMember.status === "creator";
    const isSystemAdmin = env.ADMIN_USERS.includes(ctx.from.id);
    const isAuthorized = await isUserAuthorized(userId, chatId.toString());
    const isGameStarter = existingGame.startedBy === userId;
    const isPrivate = ctx.chat.type === "private";
    const isPermitted =
      isAdmin || isSystemAdmin || isGameStarter || isAuthorized || isPrivate;

    if (isPermitted) {
      const userName =
        ctx.from.first_name +
        (ctx.from.last_name ? " " + ctx.from.last_name : "");
      const userLink = `<a href="tg://user?id=${ctx.from.id}">${escHtml(userName)}</a>`;

      let reason = "";
      if (isPrivate) {
        reason = "";
      } else if (isGameStarter) {
        reason = `<b>Ended by game starter: </b>${userLink}`;
      } else if (isSystemAdmin) {
        reason = `<b>Ended by system administrator: </b>${userLink}`;
      } else if (isAdmin) {
        reason = `<b>Ended by group administrator: </b>${userLink}`;
      } else if (isAuthorized) {
        reason = `<b>Ended by authorized user: </b>${userLink}`;
      } else {
        reason = `<b>Ended by: </b>${userLink}`;
      }

      await ctx.deleteMessage();
      await endGame(ctx, chatId, existingGame.word, reason);

      return await ctx.answerCallbackQuery({
        text: "Game ended by admin/game starter! 🎯",
      });
    }

    voteData.voters.push(userId);

    if (voteData.voters.length >= 3) {
      await redis.del(voteKey);

      const reason = "<b>Game ended - 3 players voted to end the game</b>";
      await ctx.deleteMessage();
      await endGame(ctx, chatId, existingGame.word, reason);

      return await ctx.answerCallbackQuery({
        text: "Game ended! Voting threshold reached. 🎯",
      });
    }

    await redis.setex(voteKey, 300, JSON.stringify(voteData));

    const votesNeeded = 3 - voteData.voters.length;

    await ctx.editMessageText(
      `<b>🗳️ Vote to End Game</b>\n\n` +
        `Players are voting to end the game.\n\n` +
        `<b>Votes needed: 3 total</b>\n` +
        `<b>Current votes: ${voteData.voters.length}/3</b>\n\n` +
        `React with the button below to vote for ending the game.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `✅ Vote to End (${voteData.voters.length}/3)`,
                callback_data: `vote_end ${chatId}`,
              },
            ],
          ],
        },
        parse_mode: "HTML",
      },
    );

    await ctx.answerCallbackQuery({
      text: `Vote recorded! ${votesNeeded} more votes needed.`,
    });
  } else if (ctx.callbackQuery.data.startsWith("help_")) {
    type HelpSection = "howto" | "scores" | "group" | "other" | "admin";

    if (!ctx.from) {
      await ctx.answerCallbackQuery();
      return;
    }

    const isAdminOrOwner =
      (env.ADMIN_USERS.includes(ctx.from.id) || (await isBotAdmin(ctx.from.id))) &&
      ctx.chat?.type === "private";
    let message = "";
    let activeSection: HelpSection = "howto";

    switch (ctx.callbackQuery.data) {
      case "help_main":
      case "help_howto":
        message = getHowToPlayMessage();
        activeSection = "howto";
        break;
      case "help_scores":
        message = getScoresMessage();
        activeSection = "scores";
        break;
      case "help_group":
        if (!isAdminOrOwner) {
          await ctx.answerCallbackQuery({
            text: "You don't have permission to view this.",
            show_alert: true,
          });
          return;
        }
        message = getGroupSettingsMessage();
        activeSection = "group";
        break;
      case "help_other":
        if (!isAdminOrOwner) {
          await ctx.answerCallbackQuery({
            text: "You don't have permission to view this.",
            show_alert: true,
          });
          return;
        }
        message = getOtherCommandsMessage();
        activeSection = "other";
        break;
      case "help_admin":
        if (!isAdminOrOwner) {
          await ctx.answerCallbackQuery({
            text: "You don't have permission to view this.",
            show_alert: true,
          });
          return;
        }
        message = getAdminCommandsMessage();
        activeSection = "admin";
        break;
      default:
        await ctx.answerCallbackQuery();
        return;
    }

    const keyboard = getMainHelpKeyboard(isAdminOrOwner, activeSection);

    const commonOptions = {
      parse_mode: "HTML" as const,
      reply_markup: keyboard,
    };

    try {
      await ctx.editMessageText(message, commonOptions);
    } catch (err) {
      if (
        err instanceof GrammyError &&
        !err.description.includes("message is not modified:")
      ) {
        await ctx.deleteMessage();
        await ctx.reply(message, commonOptions);
      }
    }

    await ctx.answerCallbackQuery();
  } else if (ctx.callbackQuery.data.startsWith("captcha_")) {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id.toString();
    const chatId = ctx.chat?.id.toString();
    const name = ctx.from.first_name;
    const username = ctx.from.username;

    if (!chatId) return;

    const key = `captcha:${chatId}:${userId}`;
    const raw = await redis.get(key);

    if (!raw) {
      return ctx.answerCallbackQuery({
        text: "Captcha expired or, this captcha isn't for you.",
        show_alert: true,
      });
    }

    const session = captchaSchema.parse(JSON.parse(raw));

    const mentionText = formatUserMention({ id: userId, name, username });

    if (data === "captcha_clear") {
      session.progress = [];
    } else if (data === "captcha_back") {
      session.progress.pop();
    }

    if (data.startsWith("captcha_pick")) {
      const emoji = data.split(" ")[1];
      if (session.progress.length < 3) {
        session.progress.push(emoji);
      }
    }

    const keyboard = buildCaptchaKeyboard(session.progress);

    if (session.progress.length === 3) {
      const success =
        JSON.stringify(session.progress) === JSON.stringify(session.answer);

      if (success) {
        await redis.del(key);

        await ctx.api.sendMessage(
          session.adminId,
          `✅ ${mentionText} passed the captcha.`,
          { parse_mode: "HTML" },
        );

        return ctx
          .editMessageText(
            buildMessage({
              mention: mentionText,
              progress: session.progress,
              attempts: session.attempts,
              maxAttempts: 3,
              status: "Verification successful ✅",
            }),
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }

      session.attempts += 1;

      if (session.attempts >= 3) {
        await redis.del(key);

        await ctx.api.sendMessage(
          session.adminId,
          `❌ ${mentionText} failed the captcha.\nExpected: ${session.answer.join(" ")}\nGot: ${session.progress.join(" ")}`,
          { parse_mode: "HTML" },
        );

        return ctx
          .editMessageText(
            buildMessage({
              mention: mentionText,
              progress: session.answer,
              attempts: session.attempts,
              maxAttempts: 3,
              status: "Verification failed ❌",
            }),
            { parse_mode: "HTML" },
          )
          .catch(() => {});
      }

      session.progress = [];
      await redis.set(key, JSON.stringify(session), "KEEPTTL");

      return ctx
        .editMessageText(
          buildMessage({
            mention: mentionText,
            progress: [],
            attempts: session.attempts,
            maxAttempts: 3,
            status: "Incorrect selection. Try again.",
          }),
          { reply_markup: keyboard, parse_mode: "HTML" },
        )
        .catch(() => {});
    }

    await redis.set(key, JSON.stringify(session), "KEEPTTL");

    await ctx
      .editMessageText(
        buildMessage({
          mention: mentionText,
          progress: session.progress,
          attempts: session.attempts,
          maxAttempts: 3,
        }),
        { reply_markup: keyboard, parse_mode: "HTML" },
      )
      .catch(() => {});

    return ctx.answerCallbackQuery();
  }

  // ── Custom title approve/reject ────────────────────────────────────────────
  if (
    ctx.callbackQuery.data.startsWith("title_approve ") ||
    ctx.callbackQuery.data.startsWith("title_reject ")
  ) {
    if (!env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Only the bot owner can do this.", show_alert: true });
    }

    const [action, targetUserId] = ctx.callbackQuery.data.split(" ");
    if (!targetUserId) return ctx.answerCallbackQuery();

    const pendingKey = `title_req:${targetUserId}`;
    const requested = await redis.get(pendingKey);

    if (!requested) {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return ctx.answerCallbackQuery({ text: "Request not found or already handled.", show_alert: true });
    }

    if (action === "title_approve") {
      await redis.set(`custom_title:${targetUserId}`, requested, "EX", 365 * 86400);
      await redis.del(pendingKey);

      try {
        await ctx.api.sendMessage(
          parseInt(targetUserId),
          `${pe("🎉")} <b>Custom Title Approved!</b>\n\n` +
            `<blockquote>Your custom title <b>「${escHtml(requested)}」</b> has been approved by the owner!\n\n` +
            `It will now appear on the leaderboard next to your name. ${pe("✨")}</blockquote>`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await ctx.editMessageText(
        (ctx.callbackQuery.message?.text ?? "") + `\n\n✅ <b>APPROVED</b> by ${escHtml(ctx.from.first_name)}`,
        { parse_mode: "HTML" },
      ).catch(() => {});
      return ctx.answerCallbackQuery({ text: `✅ Approved! Title set for user ${targetUserId}.` });
    } else {
      await redis.del(pendingKey);

      try {
        await ctx.api.sendMessage(
          parseInt(targetUserId),
          `${pe("😔")} <b>Custom Title Request Rejected</b>\n\n` +
            `<blockquote>Your custom title request "<b>${escHtml(requested)}</b>" was not approved.\n\n` +
            `You can submit a new request with /requesttitle.</blockquote>`,
          { parse_mode: "HTML" },
        );
      } catch {}

      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
      await ctx.editMessageText(
        (ctx.callbackQuery.message?.text ?? "") + `\n\n❌ <b>REJECTED</b> by ${escHtml(ctx.from.first_name)}`,
        { parse_mode: "HTML" },
      ).catch(() => {});
      return ctx.answerCallbackQuery({ text: `❌ Rejected. User notified.` });
    }
  }

  // ── Ban confirm / cancel ──────────────────────────────────────────────────
  if (ctx.callbackQuery.data.startsWith("confirm_ban_")) {
    const ownerId = ctx.callbackQuery.data.replace("confirm_ban_", "");
    if (ctx.from.id.toString() !== ownerId && !env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Only the person who issued /ban can confirm.", show_alert: true });
    }
    const pendingKey = `pending_ban:${ownerId}`;
    const raw = await redis.get(pendingKey);
    if (!raw) {
      await ctx.editMessageText("⚠️ This ban request has expired (60s limit).", { parse_mode: "HTML" }).catch(() => {});
      return ctx.answerCallbackQuery({ text: "Request expired." });
    }
    const { target, reason } = JSON.parse(raw);
    await redis.del(pendingKey);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await executeBan(ctx as any, target, reason);
    return ctx.answerCallbackQuery({ text: "Ban executed." });
  }

  if (ctx.callbackQuery.data.startsWith("cancel_ban_")) {
    const ownerId = ctx.callbackQuery.data.replace("cancel_ban_", "");
    if (ctx.from.id.toString() !== ownerId && !env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Only the person who issued /ban can cancel.", show_alert: true });
    }
    await redis.del(`pending_ban:${ownerId}`);
    await ctx.editMessageText("❌ <b>Ban cancelled.</b>", { parse_mode: "HTML" }).catch(() => {});
    return ctx.answerCallbackQuery({ text: "Cancelled." });
  }

  // ── Unban confirm / cancel ────────────────────────────────────────────────
  if (ctx.callbackQuery.data.startsWith("confirm_unban_")) {
    const ownerId = ctx.callbackQuery.data.replace("confirm_unban_", "");
    if (ctx.from.id.toString() !== ownerId && !env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Only the person who issued /unban can confirm.", show_alert: true });
    }
    const pendingKey = `pending_unban:${ownerId}`;
    const raw = await redis.get(pendingKey);
    if (!raw) {
      await ctx.editMessageText("⚠️ This unban request has expired (60s limit).", { parse_mode: "HTML" }).catch(() => {});
      return ctx.answerCallbackQuery({ text: "Request expired." });
    }
    const { target } = JSON.parse(raw);
    await redis.del(pendingKey);
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await executeUnban(ctx as any, target);
    return ctx.answerCallbackQuery({ text: "Unban executed." });
  }

  if (ctx.callbackQuery.data.startsWith("cancel_unban_")) {
    const ownerId = ctx.callbackQuery.data.replace("cancel_unban_", "");
    if (ctx.from.id.toString() !== ownerId && !env.ADMIN_USERS.includes(ctx.from.id)) {
      return ctx.answerCallbackQuery({ text: "Only the person who issued /unban can cancel.", show_alert: true });
    }
    await redis.del(`pending_unban:${ownerId}`);
    await ctx.editMessageText("❌ <b>Unban cancelled.</b>", { parse_mode: "HTML" }).catch(() => {});
    return ctx.answerCallbackQuery({ text: "Cancelled." });
  }
});

export const callbackQueryHandler = composer;
