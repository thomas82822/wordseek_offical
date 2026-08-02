import { Composer, Context } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { memCache } from "../config/cache";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";
import { logGameEnded } from "../services/logging";
// import { formatWordDetails } from "../util/format-word-details";
import { requireAllowedTopic, runGuards } from "../util/guards";

const composer = new Composer();

export async function isUserAuthorized(userId: string, chatId: string) {
  const authorized = await db
    .selectFrom("authorizedUsers")
    .where("userId", "=", userId)
    .where("chatId", "=", chatId)
    .executeTakeFirst();

  return !!authorized;
}

export async function endGame(
  ctx: Context,
  chatId: number,
  word: string,
  reason: string,
  topicId?: string,
) {
  const game = await db
    .deleteFrom("games")
    .where("activeChat", "=", String(chatId))
    .returning("word")
    .executeTakeFirst();

  // Clear all cache layers so stale data isn't served after /end
  if (topicId) {
    memCache.del(`gs:${chatId}:${topicId}`);
    redis.del(`game_state:${chatId}:${topicId}`).catch(() => {});
  }

  const wordLength = game?.word ? game.word.length : 5;

  //   await ctx.reply(
  //     `<blockquote>🎮 <b>Game Ended</b></blockquote>
  // ${formatWordDetails(word)}<blockquote>${reason ? `${reason}\n` : ""}Start a new game with /new</blockquote>`,
  //     { parse_mode: "HTML" },
  //   );

  await ctx.reply(
    `<blockquote>${pe("🎮")} <b>Game Ended</b>\nCorrect Word: <b>${word}</b></blockquote>
<blockquote>${reason ? `${reason}\n` : ""}Start a new game with /new${wordLength}</blockquote>`,
    { parse_mode: "HTML" },
  );

  // Log manual game end to channel (fire-and-forget)
  if (ctx.from) {
    logGameEnded({
      chatId: String(chatId),
      chatTitle: ctx.chat && "title" in ctx.chat ? (ctx.chat.title ?? null) : null,
      user: {
        id: ctx.from.id.toString(),
        name: ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : ""),
        username: ctx.from.username ?? null,
      },
      word,
      wordLength,
      reason: reason || "Manual /end command",
    }).catch(() => {});
  }
}

composer.command("end", async (ctx) => {
  const chatId = ctx.chat.id;
  if (!ctx.message) return;

  const guard = await runGuards(ctx, [requireAllowedTopic]);
  if (!guard.ok) return ctx.reply(guard.message);

  const currentGame = await db
    .selectFrom("games")
    .selectAll()
    .where("activeChat", "=", String(ctx.chat.id))
    .executeTakeFirst();

  if (!currentGame) return ctx.reply("There is no game in progress.");

  const userId = ctx.from.id.toString();
  const chatMember = await ctx.getChatMember(parseInt(userId));

  const isAdmin =
    chatMember.status === "administrator" || chatMember.status === "creator";
  const isSystemAdmin = env.ADMIN_USERS.includes(ctx.from.id);
  const isGameStarter = currentGame.startedBy === userId;
  const isAuthorized = await isUserAuthorized(userId, chatId.toString());
  const isPrivate = ctx.chat.type === "private";

  const isPermitted =
    isAdmin || isSystemAdmin || isGameStarter || isAuthorized || isPrivate;

  if (isPermitted) {
    const userName =
      ctx.from.first_name +
      (ctx.from.last_name ? " " + ctx.from.last_name : "");
    const userLink = `<a href="tg://user?id=${ctx.from.id}">${userName}</a>`;

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

    return await endGame(ctx, chatId, currentGame.word, reason, currentGame.topicId);
  }

  const voteKey = `vote:${chatId}`;
  const existingVotes = await redis.get(voteKey);

  if (existingVotes) {
    return await ctx.reply(
      `${pe("⏳")} A vote to end the game is already in progress. Please wait for it to complete.`,
    );
  }

  const voteData = {
    voters: [userId],
    initiatedAt: Date.now(),
  };

  await redis.setex(voteKey, 300, JSON.stringify(voteData)); // 5 minutes expiry

  const userName =
    ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : "");

  await ctx.reply(
    `<b>${pe("🗳️")} Vote to End Game</b>\n\n` +
      `<a href="tg://user?id=${ctx.from.id}">${userName}</a> wants to end the game.\n\n` +
      `<b>Votes needed: 3 out of remaining players</b>\n` +
      `<b>Current votes: 1/3</b>\n\n` +
      `React with the button below to vote for ending the game.`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "✅ Vote to End (1/3)",
              callback_data: `vote_end ${chatId}`,
            },
          ],
        ],
      },
    },
  );
});

CommandsHelper.addNewCommand(
  "end",
  "End the current game. Available for only admins in groups.",
);

export const endGameCommand = composer;
