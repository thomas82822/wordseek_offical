/**
 * Auto Game Service (Fix 4)
 *
 * After a game ends in a group, after 1 hour the bot automatically
 * starts a new game by directly inserting into the DB (programmatically).
 * Sending "/new5" as a bot message doesn't work — bot ignores its own messages.
 */

import { CronJob } from "cron";

import { bot } from "../config/bot";
import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { scanKeys } from "../util/scan-keys";
import { WordSelector, type WordLength } from "../util/word-selector";

const AUTO_GAME_KEY_PREFIX = "autogame:last_ended:";
const AUTO_GAME_ENABLED_KEY = "autogame:enabled";

/**
 * Record that a game just ended in a chat (called when game is deleted).
 */
export async function recordGameEnded(chatId: string, topicId: string): Promise<void> {
  const key = `${AUTO_GAME_KEY_PREFIX}${chatId}:${topicId}`;
  await redis.set(key, Date.now().toString(), "EX", 7200).catch(() => {}); // 2hr TTL
}

/**
 * Enable/disable auto game for the bot.
 */
export async function setAutoGame(enabled: boolean): Promise<void> {
  if (enabled) await redis.set(AUTO_GAME_ENABLED_KEY, "1");
  else await redis.del(AUTO_GAME_ENABLED_KEY);
}

export async function isAutoGameEnabled(): Promise<boolean> {
  const val = await redis.get(AUTO_GAME_ENABLED_KEY);
  return val === "1";
}

/**
 * Check all chats where a game ended 1hr ago and start new games.
 * Runs every 5 minutes. Starts game PROGRAMMATICALLY (not by sending /new5).
 */
async function runAutoGameCheck(): Promise<void> {
  if (!(await isAutoGameEnabled())) return;

  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;

  // Get all autogame keys
  // Use scanKeys instead of redis.keys() — safe for production, non-blocking.
  const keys = await scanKeys(`${AUTO_GAME_KEY_PREFIX}*`);

  for (const key of keys) {
    const val = await redis.get(key);
    if (!val) continue;

    const lastEnded = parseInt(val);
    const elapsed = now - lastEnded;

    if (elapsed >= ONE_HOUR_MS && elapsed < ONE_HOUR_MS + 5 * 60 * 1000) {
      // Parse chatId and topicId from key
      const suffix = key.replace(AUTO_GAME_KEY_PREFIX, "");
      const colonIdx = suffix.lastIndexOf(":");
      const chatId = suffix.substring(0, colonIdx);
      const topicId = suffix.substring(colonIdx + 1);

      // Check if there's already an active game
      const existingGame = await db
        .selectFrom("games")
        .selectAll()
        .where("activeChat", "=", chatId)
        .where("topicId", "=", topicId)
        .executeTakeFirst();

      if (!existingGame) {
        const threadId = topicId !== "general" ? parseInt(topicId) : undefined;

        try {
          // Pick a random word length for the auto-game
          const lengths: WordLength[] = [4, 5, 6];
          const randomLen = lengths[Math.floor(Math.random() * lengths.length)];

          // Use WordSelector to get a non-repeated word for this chat
          const wordSelector = new WordSelector();
          const randomWord = await wordSelector.getRandomWord(chatId, randomLen);

          // Programmatically insert game into DB (bot can't trigger its own commands)
          await db
            .insertInto("games")
            .values({
              word: randomWord,
              activeChat: chatId,
              topicId,
              startedBy: "auto",
            })
            .execute();

          // Announce to the group
          await bot.api.sendMessage(
            parseInt(chatId),
            `🎮 <b>Auto Game Started!</b>\n\n` +
              `A new <b>${randomLen}-letter</b> game has begun automatically.\n` +
              `Start guessing! Use /end to stop.`,
            {
              parse_mode: "HTML",
              message_thread_id: threadId,
            },
          );
        } catch {
          // Chat may have removed bot or unique constraint hit (game already exists)
        }

        // Delete the key so it doesn't trigger again
        await redis.del(key);
      } else {
        // Game already running — clear the key
        await redis.del(key);
      }
    } else if (elapsed >= ONE_HOUR_MS + 5 * 60 * 1000) {
      // Too old — clean up
      await redis.del(key);
    }
  }
}

export const autoGameCron = new CronJob(
  "0 */5 * * * *", // Every 5 minutes
  async () => {
    try {
      await runAutoGameCheck();
    } catch {}
  },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);
