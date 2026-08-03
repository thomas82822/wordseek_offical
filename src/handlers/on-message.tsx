import { InputFile } from "grammy";
import { ReactionTypeEmoji } from "grammy/types";
import { Composer, Context, GrammyError } from "grammy";

import z from "zod";
import sharp from "sharp";
import { join } from "path";
import satori from "satori";
import { sql } from "kysely";
import { readFile } from "fs/promises";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { memCache } from "../config/cache";
import allSixWords from "../data/all-six.json";
import allFiveWords from "../data/all-five.json";
import allFourWords from "../data/all-four.json";
import { requireAllowedTopic, runGuards } from "../util/guards";
import { PREMIUM_EMOJI_IDS, pe, randomPremiumEmoji } from "../config/constants";
import { formatDailyWordDetails } from "../util/format-word-details";
import { getCurrentGameDateString } from "../services/daily-wordle-cron";
import { checkAndMaybeFreeze, isUserFrozen } from "../services/anticheat";
import { notifyPendingDropIfAny } from "../commands/hourlypromo";
import { recordGameEnded } from "../services/auto-game";
import { registerBotChat } from "../services/bot-mode";
import { syncToGitHub } from "../services/github-sync";
import { logGameWon, logGameOver } from "../services/logging";

const composer = new Composer();

// Font cached in memory once at first use — avoids disk read on every guess (500ms → ~10ms)
let _cachedFontData: Buffer | null = null;
async function getFontData(): Promise<Buffer> {
  if (!_cachedFontData) {
    const fontPath = join(process.cwd(), "src", "fonts", "roboto.ttf");
    _cachedFontData = await readFile(fontPath);
  }
  return _cachedFontData;
}
// Pre-warm font at process start — first user guess is instant, not slow
getFontData().catch(() => {});

type WordLength = 4 | 5 | 6;

const ALL_WORDS: Record<WordLength, string[]> = {
  4: allFourWords,
  5: allFiveWords,
  6: allSixWords,
};

// Pre-built Sets for O(1) word validation — built ONCE at startup, not per-request
const ALL_WORDS_SET: Record<WordLength, Set<string>> = {
  4: new Set(allFourWords.map((w) => w.toLowerCase())),
  5: new Set(allFiveWords.map((w) => w.toLowerCase())),
  6: new Set(allSixWords.map((w) => w.toLowerCase())),
};

const MODE_LABEL: Record<WordLength, string> = {
  4: "4-letter mode",
  5: "5-letter mode",
  6: "6-letter mode",
};

export const dailyWordleSchema = z.object({
  dailyWordId: z.number(),
  date: z.string(),
});

// ── Speed fix: Redis-cached daily guesses ────────────────────────────────────
// Daily guesses are stored in a Redis list "daily_guesses:<userId>:<dailyWordId>".
// Before this fix, EVERY guess loaded all previous guesses from Postgres — a full
// table scan per user per guess.  With Redis the list is built incrementally and
// served from memory (0–2 ms) on every subsequent guess.
// TTL = 90 000 s (25 h) — same as the daily word cache so they expire together.
const DAILY_GUESSES_TTL = 90_000;

async function getCachedDailyGuesses(userId: string, dailyWordId: number): Promise<any[]> {
  const cacheKey = `daily_guesses:${userId}:${dailyWordId}`;
  try {
    const raw = await redis.lrange(cacheKey, 0, -1);
    if (raw && raw.length > 0) return raw.map((r) => JSON.parse(r));
  } catch {}
  // Cache miss — load from DB and warm the cache
  const rows = await db
    .selectFrom("dailyGuesses")
    .selectAll()
    .where("userId", "=", userId)
    .where("dailyWordId", "=", dailyWordId)
    .orderBy("attemptNumber", "asc")
    .execute();
  if (rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const row of rows) pipeline.rpush(cacheKey, JSON.stringify(row));
    pipeline.expire(cacheKey, DAILY_GUESSES_TTL);
    pipeline.exec().catch(() => {});
  }
  return rows;
}

async function appendDailyGuessToCache(userId: string, dailyWordId: number, guess: object): Promise<void> {
  const cacheKey = `daily_guesses:${userId}:${dailyWordId}`;
  try {
    await redis.pipeline()
      .rpush(cacheKey, JSON.stringify(guess))
      .expire(cacheKey, DAILY_GUESSES_TTL)
      .exec();
  } catch {}
}

function clearDailyGuessCache(userId: string, dailyWordId: number): void {
  redis.del(`daily_guesses:${userId}:${dailyWordId}`).catch(() => {});
}

// ── Speed fix: Redis-cached guess list ─────────────────────────────────────
// Guesses are stored in a Redis list "game_guesses:<gameId>" so we NEVER hit
// the DB again after the initial game-state lookup.  The list is built
// incrementally: each new guess is RPUSH-ed immediately after insertion.
// On a cache miss (e.g. after restart) we fall back to DB and repopulate.

async function getCachedGuesses(gameId: number): Promise<GuessEntry[]> {
  const cacheKey = `game_guesses:${gameId}`;
  try {
    const raw = await redis.lrange(cacheKey, 0, -1);
    if (raw && raw.length > 0) {
      return raw.map((r) => JSON.parse(r) as GuessEntry);
    }
  } catch {}
  // Fallback: load from DB and warm the cache
  const rows = await db
    .selectFrom("guesses")
    .selectAll()
    .where("gameId", "=", gameId)
    .orderBy("createdAt", "asc")
    .execute();
  if (rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const row of rows) pipeline.rpush(cacheKey, JSON.stringify(row));
    pipeline.expire(cacheKey, 86400);
    pipeline.exec().catch(() => {});
  }
  return rows;
}

async function appendGuessToCache(gameId: number, guess: GuessEntry): Promise<void> {
  const cacheKey = `game_guesses:${gameId}`;
  try {
    // Single pipeline round-trip instead of two sequential Redis calls (saves ~5-15ms on Heroku)
    await redis.pipeline()
      .rpush(cacheKey, JSON.stringify(guess))
      .expire(cacheKey, 86400)
      .exec();
  } catch {}
}

async function clearGuessCache(gameId: number): Promise<void> {
  redis.del(`game_guesses:${gameId}`).catch(() => {});
}

composer.on("message:text", async (ctx) => {
  const currentGuess = ctx.message.text?.toLowerCase();

  const isValidWord = /^[a-z]{4,6}$/.test(currentGuess ?? "");

  if (!isValidWord || currentGuess.startsWith("/")) {
    return;
  }

  const userId = ctx.from.id.toString();
  const chatId = ctx.chat.id.toString();

  if (ctx.chat.type === "private") {
    // Parallel: fetch daily game session + verify it's still today's date
    const dailyGameData = await redis.get(`daily_wordle:${userId}`);
    const result = dailyWordleSchema.safeParse(
      JSON.parse(dailyGameData || "{}"),
    );
    if (result.success) {
      const todayDate = getCurrentGameDateString();

      if (result.data.date !== todayDate) {
        await redis.del(`daily_wordle:${userId}`);
        return ctx.reply(
          "Your previous game has expired. Please start today's WordSeek with /daily",
        );
      }

      return handleDailyWordleGuess(ctx, currentGuess);
    }
    // No /daily game active — fall through to check for a regular /new game in DM
  }

  // ── Group message handling ───────────────────────────────────────────────

  const currentTopicId = ctx.msg.message_thread_id?.toString() || "general";
  const gameStateKey = `game_state:${chatId}:${currentTopicId}`;
  const gameMemKey   = `gs:${chatId}:${currentTopicId}`;

  // ── Three-layer game state lookup: memory (0ms) → Redis (2ms) → DB (10ms) ─
  let currentGame: any;

  // Layer 1: in-process memory — zero network cost
  currentGame = memCache.get<any>(gameMemKey);

  // Layer 2: Redis — one network hop
  if (!currentGame) {
    try {
      const cached = await redis.get(gameStateKey);
      if (cached) {
        currentGame = JSON.parse(cached);
        memCache.set(gameMemKey, currentGame, 30_000); // 30 s in-memory
      }
    } catch {}
  }

  // Layer 3: DB — only on a cold start or after a restart
  if (!currentGame) {
    currentGame = await db
      .selectFrom("games")
      .selectAll()
      .where("activeChat", "=", ctx.chat.id.toString())
      .where("topicId", "=", currentTopicId)
      .executeTakeFirst();
    if (currentGame) {
      memCache.set(gameMemKey, currentGame, 30_000);
      redis.setex(gameStateKey, 86400, JSON.stringify(currentGame)).catch(() => {});
    }
  }
  if (!currentGame) return;

  // ── Track this chat for auto-game ───────────────────────────────────────
  registerBotChat(chatId, currentTopicId).catch(() => {});

  // Topic is implicitly allowed — a game is running here.
  // requireAllowedTopic is enforced on /new command, not on guesses.

  const wordLength = currentGame.word.length as WordLength;

  if (currentGuess.length !== wordLength) return;

  // O(1) Set lookup — instant, no array scan
  if (!ALL_WORDS_SET[wordLength].has(currentGuess))
    return ctx.reply(
      `${currentGuess} is not a valid ${wordLength}-letter word.`,
    );

  // Redis-cached duplicate guess check — avoids DB hit on every wrong guess
  const guessedSetKey = `guessed:${currentGame.id}`;
  let guessExists = false;
  try {
    guessExists = await redis.sismember(guessedSetKey, currentGuess) === 1;
  } catch {
    // Redis miss — fall back to DB.
    // IMPORTANT: filter by gameId (not chatId) so a new game doesn't reject
    // words that were guessed in a previous game in the same chat.
    const row = await db
      .selectFrom("guesses")
      .select("guess")
      .where("guess", "=", currentGuess)
      .where("gameId", "=", currentGame.id)
      .executeTakeFirst();
    guessExists = !!row;
  }

  if (guessExists)
    return ctx.reply(
      "Someone has already guessed your word. Please try another one!",
    );

  if (currentGuess === currentGame.word) {
    if (!ctx.from.is_bot) {
      // ── Race condition lock — only one correct-guess per game ────────────
      const gameLockKey = `game_lock:${currentGame.id}`;
      const locked = await redis.set(gameLockKey, userId, "EX", 15, "NX");
      if (!locked) {
        // Another user's correct guess is already being processed
        return ctx.reply(
          "⚡ Someone just guessed it first! Start with /new" + wordLength,
        );
      }

      // ── Parallel: fetch guesses + freeze check at same time ────────────
      const [allGuesses, isFrozen] = await Promise.all([
        getCachedGuesses(currentGame.id),
        isUserFrozen(userId),
      ]);

      const score = 30 - allGuesses.length;
      if (isFrozen) {
        // Silent — frozen users get no score, just a reaction
        reactWithRandom(ctx);
        memCache.del(gameMemKey);
        redis.del(gameStateKey).catch(() => {});
        clearGuessCache(currentGame.id);
        // Parallelize DB delete + lock release + auto-game record (independent ops)
        await Promise.all([
          db.deleteFrom("games").where("id", "=", currentGame.id).execute(),
          redis.del(gameLockKey),
          recordGameEnded(chatId, currentTopicId),
        ]);
        return;
      }

      // Check anti-cheat (non-blocking — owner approves manually)
      checkAndMaybeFreeze(userId, score, chatId).catch(() => {});

      // Add score to leaderboard
      await db
        .insertInto("leaderboard")
        .values({
          score,
          chatId,
          userId,
          wordLength: wordLength.toString() as "4" | "5" | "6",
        })
        .execute();

      // ── Check 50k milestone — fire-and-forget, doesn't block reply ─────
      checkFiftyKMilestone(userId).catch(() => {});

      // Win message — reference repo style with premium emojis
      try {
        const additionalMessage = `${pe("🏆")} Added <b>${score}</b> to the leaderboard.`;
        const formattedResponse = `<blockquote>Congrats! You guessed it correctly.\nCorrect Word: <b>${escHtml(currentGame.word)}</b>\n${additionalMessage}</blockquote>\nStart with /new${wordLength}`;
        await ctx.reply(formattedResponse, {
          reply_parameters: { message_id: ctx.message.message_id },
          parse_mode: "HTML"
        });
      } catch {}
      syncToGitHub().catch(() => {});

      // Log win to channel (fire-and-forget)
      logGameWon({
        chatId,
        chatTitle: ctx.chat && "title" in ctx.chat ? (ctx.chat.title ?? null) : null,
        user: {
          id: userId,
          name: ctx.from.first_name + (ctx.from.last_name ? " " + ctx.from.last_name : ""),
          username: ctx.from.username ?? null,
        },
        word: currentGame.word,
        score,
        guessCount: allGuesses.length,
        wordLength,
      }).catch(() => {});
    }

    reactWithRandom(ctx);
    memCache.del(gameMemKey);
    redis.del(gameStateKey).catch(() => {});
    clearGuessCache(currentGame.id);
    // Parallelize DB delete + auto-game record (independent ops — saves ~20-40ms)
    await Promise.all([
      db.deleteFrom("games").where("id", "=", currentGame.id).execute(),
      recordGameEnded(chatId, currentTopicId),
    ]);
    return;
  }

  // ── Wrong guess — reply-first pattern ───────────────────────────────────
  //
  // OLD order (slow):  sadd → DB insert (15ms) → cache append → getCached → reply
  // NEW order (fast):  sadd → getCached → build reply → reply + DB write in parallel
  //
  // The Telegram API call (~100–200ms) and the DB insert (~10–20ms) now run
  // concurrently.  The user's reply goes out the moment Telegram's network
  // allows it — zero sequential DB wait on the hot path.

  // 1. Mark guess in Redis set FIRST to prevent duplicate races (cheap, ~2ms)
  redis.sadd(guessedSetKey, currentGuess)
    .then(() => redis.expire(guessedSetKey, 86400))
    .catch(() => {});

  // 2. Read existing guesses from Redis cache — 0–2 ms, no DB hit
  const existingGuesses = await getCachedGuesses(currentGame.id);

  // 3. Build the full display list with current guess appended (no DB id yet)
  const tentativeGuess: GuessEntry = {
    id: 0,
    guess: currentGuess,
    gameId: currentGame.id,
    chatId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const allGuesses = [...existingGuesses, tentativeGuess];

  if (allGuesses.length >= 30) {
    memCache.del(gameMemKey);
    redis.del(gameStateKey).catch(() => {});
    clearGuessCache(currentGame.id);
    logGameOver({
      chatId,
      chatTitle: ctx.chat && "title" in ctx.chat ? (ctx.chat.title ?? null) : null,
      word: currentGame.word,
      wordLength,
    }).catch(() => {});
    // 4 ops all independent — run entirely in parallel
    await Promise.all([
      ctx.reply(
        "Game Over! The word was " +
          currentGame.word.toUpperCase() +
          `\nYou can start a new game with /new${wordLength}`,
      ),
      db.deleteFrom("games").where("id", "=", currentGame.id).execute(),
      recordGameEnded(chatId, currentTopicId),
      db.insertInto("guesses")
        .values({ gameId: currentGame.id, guess: currentGuess, chatId })
        .execute()
        .catch(() => {}),
    ]);
    return;
  }

  const modeLabel = MODE_LABEL[wordLength];
  const feedbackText = getFeedback(allGuesses, currentGame.word);
  const responseMessage =
    `<blockquote>${modeLabel} · ${allGuesses.length}/30\n\n` +
    feedbackText +
    `</blockquote>`;

  // 4. 🚀 Telegram reply + DB write + Redis cache update — ALL in parallel.
  //    User sees the reply in ~100–150ms (Telegram RTT only).
  //    DB insert and cache update finish concurrently at zero extra cost.
  await Promise.all([
    ctx.reply(responseMessage, { parse_mode: "HTML" }),
    db.insertInto("guesses")
      .values({ gameId: currentGame.id, guess: currentGuess, chatId })
      .returningAll()
      .executeTakeFirst()
      .then((inserted) => (inserted ? appendGuessToCache(currentGame.id, inserted) : null))
      .catch(() => {}),
  ]);
});

// DM verification removed — all users can play directly without starting the bot in DM first.

// Fix 3: Notify user about pending drop once they cross 1k (was 50k)
async function checkFiftyKMilestone(userId: string): Promise<void> {
  try {
    const milestoneKey = `milestone_1k:${userId}`;
    const alreadyNotified = await redis.get(milestoneKey);
    if (alreadyNotified) return;

    const scoreResult = await db
      .selectFrom("leaderboard")
      .where("userId", "=", userId)
      .select(sql<number>`cast(sum(score) as integer)`.as("total"))
      .executeTakeFirst();

    const totalScore = Number(scoreResult?.total ?? 0);

    if (totalScore >= 1_000) {
      await redis.set(milestoneKey, "1", "EX", 86400 * 365);
      await notifyPendingDropIfAny(userId);
    }
  } catch {}
}

async function handleDailyWordleGuess(ctx: Context, currentGuess: string) {
  const userId = ctx.from!.id.toString();

  // O(1) Set lookup — was O(n) allFiveWords.includes() which scans the full array
  if (!ALL_WORDS_SET[5].has(currentGuess)) {
    return ctx.reply(`${currentGuess.toUpperCase()} is not a valid word.`);
  }

  const todayDate = getCurrentGameDateString();

  // Cache the daily word in Redis — it only changes once per day so there is
  // zero reason to hit the DB on every single guess.  TTL = 25 h so a stale
  // cached word is never served past midnight.
  let dailyWord: any;
  const dailyWordCacheKey = `daily_word:${todayDate}`;
  try {
    const cached = await redis.get(dailyWordCacheKey);
    if (cached) dailyWord = JSON.parse(cached);
  } catch {}

  if (!dailyWord) {
    dailyWord = await db
      .selectFrom("dailyWords")
      .selectAll()
      .where("date", "=", new Date(todayDate))
      .executeTakeFirst();
    if (dailyWord) {
      // 25 h TTL: survives the full game day even across midnight rounding
      redis.setex(dailyWordCacheKey, 90000, JSON.stringify(dailyWord)).catch(() => {});
    }
  }

  if (!dailyWord) {
    return ctx.reply(
      "Today's WordSeek is not available. Please try again later.",
    );
  }

  // Redis-cached — no DB hit on every guess (was hitting DB on every single guess before)
  const existingGuesses = await getCachedDailyGuesses(userId, dailyWord.id);

  const alreadyGuessed = existingGuesses.some((g) => g.guess === currentGuess);
  if (alreadyGuessed) {
    return ctx.reply(`You already guessed ${currentGuess.toUpperCase()}.`);
  }

  if (existingGuesses.length >= 6) {
    return ctx.reply(
      "You've used all your attempts for today! Come back tomorrow.",
    );
  }

  const hasWon = existingGuesses.some((g) => g.guess === dailyWord.word);
  if (hasWon) {
    return ctx.reply(
      "You've already solved today's WordSeek! Come back tomorrow for a new challenge.",
    );
  }

  const attemptNumber = existingGuesses.length + 1;

  const insertedDailyGuess = await db
    .insertInto("dailyGuesses")
    .values({
      userId,
      dailyWordId: dailyWord.id,
      guess: currentGuess,
      attemptNumber,
    })
    .returningAll()
    .executeTakeFirst();

  // Append to Redis cache immediately so subsequent reads skip DB
  if (insertedDailyGuess) {
    await appendDailyGuessToCache(userId, dailyWord.id, insertedDailyGuess);
  }

  const allGuesses = insertedDailyGuess
    ? [...existingGuesses, insertedDailyGuess]
    : [...existingGuesses, { id: 0, userId, dailyWordId: dailyWord.id, guess: currentGuess, attemptNumber, createdAt: new Date(), updatedAt: new Date() }];

  if (currentGuess === dailyWord.word) {
    await redis.del(`daily_wordle:${userId}`);

    const userStats = await db
      .selectFrom("userStats")
      .selectAll()
      .where("userId", "=", userId)
      .executeTakeFirst();

    const todayDateString = getCurrentGameDateString();
    const todayDate = new Date(todayDateString + "T00:00:00");

    let newStreak = 1;

    if (userStats?.lastGuessed) {
      const lastGuessedDate = new Date(userStats.lastGuessed);
      lastGuessedDate.setHours(0, 0, 0, 0);

      const diffTime = todayDate.getTime() - lastGuessedDate.getTime();
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 1) {
        newStreak = (userStats.currentStreak ?? 0) + 1;
      } else if (diffDays === 0) {
        newStreak = userStats.currentStreak ?? 1;
      }
    }

    const newHighestStreak = Math.max(newStreak, userStats?.highestStreak ?? 0);

    await db
      .updateTable("userStats")
      .set({
        currentStreak: newStreak,
        highestStreak: newHighestStreak,
        lastGuessed: new Date().toISOString(),
      })
      .where("userId", "=", userId)
      .execute();

    // Show "uploading photo…" indicator while satori+sharp generate the image (~300-800ms)
    ctx.replyWithChatAction("upload_photo").catch(() => {});

    const [imageBuffer, shareText] = await Promise.all([
      generateWordleImage(allGuesses, dailyWord.word),
      Promise.resolve(generateWordleShareText(dailyWord.dayNumber, allGuesses, dailyWord.word)),
    ]);

    await ctx.replyWithPhoto(new InputFile(new Uint8Array(imageBuffer)), {
      caption:
        `${randomPremiumEmoji()} Congratulations! You guessed it in ${allGuesses.length} ${allGuesses.length === 1 ? "try" : "tries"}!\n\n` +
        `${pe("🔥")} Current Streak: ${newStreak}\n${pe("⭐")} Highest Streak: ${newHighestStreak}\n\n` +
        `${formatDailyWordDetails(dailyWord)}`,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "📤 Share", switch_inline_query: shareText }],
        ],
      },
    });

    // Clear daily guess cache — game is over for this user today
    clearDailyGuessCache(userId, dailyWord.id);
    reactWithRandom(ctx);
    return;
  }

  if (allGuesses.length >= 6) {
    clearDailyGuessCache(userId, dailyWord.id);
    await handleDailyWordleLoss(ctx, dailyWord, allGuesses);
    return;
  }

  // ── Wrong daily guess — show image progress ────────────────────────────
  // Show "uploading photo…" indicator while image is generated
  ctx.replyWithChatAction("upload_photo").catch(() => {});
  const imageBuffer = await generateWordleImage(allGuesses, dailyWord.word);
  await ctx.replyWithPhoto(new InputFile(new Uint8Array(imageBuffer)), {
    caption: `${allGuesses.length}/6 attempts used. Keep going!`,
    parse_mode: "HTML",
  });
}

export function generateWordleShareText(
  dayNumber: number,
  guesses: GuessEntry[],
  solution: string,
) {
  const totalAttempts = guesses.length;
  const attemptLine = `${dayNumber} ${totalAttempts}/6`;

  const lines = guesses.map((entry) => {
    const guess = entry.guess.toUpperCase();
    const sol = solution.toUpperCase();
    const result: string[] = [];

    const solutionCount: Record<string, number> = {};
    for (const c of sol) {
      solutionCount[c] = (solutionCount[c] || 0) + 1;
    }

    for (let i = 0; i < guess.length; i++) {
      if (guess[i] === sol[i]) {
        result[i] = "🟩";
        solutionCount[guess[i]]--;
      }
    }

    for (let i = 0; i < guess.length; i++) {
      if (result[i]) continue;
      if (solutionCount[guess[i]] > 0) {
        result[i] = "🟨";
        solutionCount[guess[i]]--;
      } else {
        result[i] = "⬛";
      }
    }

    return result.join("");
  });

  return `WordSeek ${attemptLine}\n\n${lines.join("\n")}\nTry yourself by using /daily command.`;
}

async function handleDailyWordleLoss(
  ctx: Context,
  dailyWord: any,
  allGuesses: GuessEntry[],
) {
  const userId = ctx.from!.id.toString();

  // Clear daily guess cache — game over
  clearDailyGuessCache(userId, dailyWord.id);
  await redis.del(`daily_wordle:${userId}`);

  await db
    .updateTable("userStats")
    .set({
      currentStreak: 0,
      lastGuessed: new Date().toISOString(),
    })
    .where("userId", "=", userId)
    .execute();

  const imageBuffer = await generateWordleImage(allGuesses, dailyWord.word);
  const shareText = generateWordleShareText(
    dailyWord.dayNumber,
    allGuesses,
    dailyWord.word,
  );

  await ctx.replyWithPhoto(new InputFile(new Uint8Array(imageBuffer)), {
    caption:
      `Game Over! The word was: ${dailyWord.word.toUpperCase()}\n\n` +
      `${pe("💔")} Streak reset to 0\n\n${formatDailyWordDetails(dailyWord)}\n\n` +
      `Come back tomorrow for a new challenge! ${randomPremiumEmoji()}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📤 Share", switch_inline_query: shareText }],
      ],
    },
  });
}

export const onMessageHandler = composer;

interface GuessEntry {
  id: number;
  guess: string;
  gameId?: number;
  dailyWordId?: number;
  attemptNumber?: number;
  userId?: string;
  chatId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Fix 7: Improved display — compact emoji tiles + uppercase word.
 * Emojis without extra spaces, word shown uppercase for consistent rendering.
 */
function getFeedback(data: GuessEntry[], solution: string) {
  return data
    .map((entry) => {
      const guess = entry.guess.toUpperCase();
      const sol = solution.toUpperCase();
      const solutionCount: Record<string, number> = {};

      for (const char of sol) {
        solutionCount[char] = (solutionCount[char] || 0) + 1;
      }

      const result = Array(guess.length).fill("🟥");
      for (let i = 0; i < guess.length; i++) {
        if (guess[i] === sol[i]) {
          result[i] = "🟩";
          solutionCount[guess[i]]--;
        }
      }

      for (let i = 0; i < guess.length; i++) {
        if (result[i] === "🟥" && solutionCount[guess[i]] > 0) {
          result[i] = "🟨";
          solutionCount[guess[i]]--;
        }
      }

      // Spaces between emoji squares, bold word via HTML <b> tag
      const feedback = result.join(" ");
      return `${feedback} <b>${guess}</b>`;
    })
    .join("\n");
}

export async function generateWordleImage(
  data: GuessEntry[],
  solution: string,
) {
  const tiles = data.map((entry) => {
    const guess = entry.guess.toUpperCase();
    const solutionCount: Record<string, number> = {};

    for (const char of solution.toUpperCase()) {
      solutionCount[char] = (solutionCount[char] || 0) + 1;
    }

    const result = Array(guess.length).fill("absent");

    for (let i = 0; i < guess.length; i++) {
      if (guess[i] === solution.toUpperCase()[i]) {
        result[i] = "correct";
        solutionCount[guess[i]]--;
      }
    }

    for (let i = 0; i < guess.length; i++) {
      if (result[i] === "absent" && solutionCount[guess[i]] > 0) {
        result[i] = "present";
        solutionCount[guess[i]]--;
      }
    }

    return { guess, result };
  });

  const wordLength = solution.length;
  const maxRows = 6;

  // Pad rows to always show 6 rows
  const paddedTiles: { guess: string; result: string[] }[] = [...tiles];
  while (paddedTiles.length < maxRows) {
    paddedTiles.push({
      guess: " ".repeat(wordLength),
      result: Array(wordLength).fill("empty"),
    });
  }

  const tileSize = 60;
  const gap = 8;
  const padding = 16;
  const width = wordLength * (tileSize + gap) - gap + padding * 2;
  const height = maxRows * (tileSize + gap) - gap + padding * 2;

  const fontData = await getFontData();

  function getColor(state: string): string {
    switch (state) {
      case "correct": return "#538d4e";
      case "present": return "#b59f3b";
      case "absent": return "#3a3a3c";
      default: return "#121213";
    }
  }

  const svg = await satori(
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#121213",
        width: `${width}px`,
        height: `${height}px`,
        padding: `${padding}px`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        {paddedTiles.map(({ guess, result }, rowIdx) => (
          <div key={rowIdx} style={{ display: "flex", gap: "8px" }}>
            {guess.split("").map((letter, i) => (
              <div
                key={i}
                style={{
                  width: "60px",
                  height: "60px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background:
                    result[i] === "empty" ? "#3a3a3c" : getColor(result[i]),
                  color: result[i] === "empty" ? "#3a3a3c" : "white",
                  fontSize: "32px",
                  fontWeight: "bold",
                  border: result[i] === "empty" ? "2px solid #565758" : "none",
                }}
              >
                {letter.trim()}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>,
    {
      width,
      height,
      fonts: [
        {
          name: "Roboto",
          data: fontData,
          weight: 700,
          style: "normal",
        },
      ],
    },
  );

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return pngBuffer;
}

async function reactWithRandom(ctx: Context) {
  const premiumIds = [...PREMIUM_EMOJI_IDS].sort(() => Math.random() - 0.5);

  for (const customEmojiId of premiumIds.slice(0, 3)) {
    try {
      await ctx.react({ type: "custom_emoji", custom_emoji_id: customEmojiId });
      return;
    } catch (err) {
      if (
        err instanceof GrammyError &&
        (err.description?.includes("REACTION_NOT_ALLOWED") ||
          err.description?.includes("CUSTOM_EMOJI"))
      ) {
        // Chat doesn't support custom emoji reactions at all — stop trying premium IDs
        break;
      }
      // Other error (network, timeout, etc.) — try the next premium emoji ID
      continue;
    }
  }

  const emojis: ReactionTypeEmoji["emoji"][] = [
    "🎉", "🏆", "🤩", "⚡", "🫡", "💯", "❤‍🔥", "🦄",
  ];

  const shuffled = emojis.sort(() => Math.random() - 0.5);

  for (const emoji of shuffled) {
    try {
      await ctx.react(emoji);
      return;
    } catch (err) {
      if (
        err instanceof GrammyError &&
        err.description?.includes("REACTION_NOT_ALLOWED")
      ) {
        continue;
      } else {
        break;
      }
    }
  }
}

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
