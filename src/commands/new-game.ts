import { CommandContext, Composer, Context } from "grammy";

import { DatabaseError } from "pg";

import { db } from "../config/db";
import { CommandsHelper } from "../util/commands-helper";
import { regularGameGuards, runGuards } from "../util/guards";
import { type WordLength, WordSelector } from "../util/word-selector";
import { syncToGitHub } from "../services/github-sync";
import { logGameStarted } from "../services/logging";
import { redis } from "../config/redis";
import { memCache } from "../config/cache";

const composer = new Composer();

const GLOBAL_VALID_LENGTHS: WordLength[] = [5, 4, 6];

async function startGame(
  ctx: CommandContext<Context>,
  forcedLength?: WordLength,
) {
  if (!ctx.from || !ctx.chat) return;

  try {
    const topicId = ctx.msg.message_thread_id?.toString() || "general";
    const chatId = ctx.chat.id;

    // DM gameplay: skip group-specific guards for private chats
    if (ctx.chat.type !== "private") {
      const guard = await runGuards(ctx, regularGameGuards);
      if (!guard.ok) return ctx.reply(guard.message);
    }

    const topicSettings = await db
      .selectFrom("chatGameTopics")
      .selectAll()
      .where("chatId", "=", chatId.toString())
      .where("topicId", "=", topicId)
      .executeTakeFirst();

    const allowedLengths: WordLength[] =
      (topicSettings?.allowedLengths as WordLength[]) ?? GLOBAL_VALID_LENGTHS;

    const defaultLength: WordLength = allowedLengths[0];

    let wordLength: WordLength;

    if (forcedLength) {
      if (!allowedLengths.includes(forcedLength)) {
        return ctx.reply(
          `Only these lengths are allowed in this topic: ${allowedLengths.join(
            ", ",
          )}.`,
        );
      }
      wordLength = forcedLength;
    } else {
      const lengthArg = ctx.match?.trim();

      if (lengthArg) {
        const parsed = Number(lengthArg) as WordLength;

        if (!allowedLengths.includes(parsed)) {
          return ctx.reply(
            `Only these lengths are allowed in this topic: ${allowedLengths.join(
              ", ",
            )}.`,
          );
        }

        wordLength = parsed;
      } else {
        wordLength = defaultLength;
      }
    }

    const wordSelector = new WordSelector();
    const randomWord = await wordSelector.getRandomWord(chatId, wordLength);

    const newGame = await db
      .insertInto("games")
      .values({
        word: randomWord,
        activeChat: chatId.toString(),
        topicId,
        startedBy: ctx.from.id.toString(),
      })
      .returningAll()
      .executeTakeFirst();

    // Cache in memory + Redis so first guess is instant (0ms memory hit)
    if (newGame) {
      memCache.set(`gs:${chatId}:${topicId}`, newGame, 30_000); // 30s in-memory
      redis.setex(`game_state:${chatId}:${topicId}`, 86400, JSON.stringify(newGame)).catch(() => {});
    }

    // Instant background save — data branch synced within 5 seconds of game start
    syncToGitHub().catch(() => {});

    // Log game start to channel (fire-and-forget)
    logGameStarted({
      chatId: chatId.toString(),
      chatTitle: "title" in ctx.chat ? (ctx.chat.title ?? null) : null,
      user: {
        id: ctx.from.id.toString(),
        name: ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : ""),
        username: ctx.from.username ?? null,
      },
      wordLength,
      gameId: newGame?.id,
    }).catch(() => {});

    return ctx.reply(`Game started! Guess the ${wordLength}-letter word!`);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      return ctx.reply(
        "There is already a game in progress in this chat. Use /end to end the current game.",
      );
    }

    console.error(error);
    return ctx.reply("Something went wrong. Please try again.");
  }
}

composer.command("new", (ctx) => startGame(ctx));

composer.command("new4", (ctx) => startGame(ctx, 4));
composer.command("new5", (ctx) => startGame(ctx, 5));
composer.command("new6", (ctx) => startGame(ctx, 6));

CommandsHelper.addNewCommand("new", "Start a new game. Usage: /new [4|5|6]");
CommandsHelper.addNewCommand("new4", "Start a new 4-letter game.");
CommandsHelper.addNewCommand("new5", "Start a new 5-letter game.");
CommandsHelper.addNewCommand("new6", "Start a new 6-letter game.");

export const newGameCommand = composer;
