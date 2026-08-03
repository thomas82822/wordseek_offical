import { db } from "../config/db";
import { redis } from "../config/redis";
import { AllowedWordLength } from "../config/constants";

type AllowedChatSearchKey = "global" | "group";
type AllowedChatTimeKey = "today" | "week" | "month" | "year" | "all";

interface SmartDefaultsParams {
  userId: string;
  chatId: string;
  requestedSearchKey?: AllowedChatSearchKey;
  requestedTimeKey?: AllowedChatTimeKey;
  requestedWordLength?: AllowedWordLength;
  chatType?: string;
}

// ── Cache TTL: 2 minutes ────────────────────────────────────────────────────
// Smart defaults only affect display order; 2-min staleness is fine and saves
// up to 6 sequential DB round-trips per /score or /leaderboard invocation.
const SMART_DEFAULTS_TTL = 120;

export async function getSmartDefaults({
  userId,
  chatId,
  requestedSearchKey,
  requestedTimeKey,
  requestedWordLength,
  chatType,
}: SmartDefaultsParams) {
  const isPrivate = chatType === "private";
  const searchKey: AllowedChatSearchKey =
    requestedSearchKey ?? (isPrivate ? "global" : "group");

  // Fast path: if the caller fully specified everything, skip DB + cache
  if (requestedTimeKey && requestedWordLength) {
    return {
      searchKey,
      timeKey: requestedTimeKey,
      wordLength: requestedWordLength,
      hasAnyScores: true,
    };
  }

  // ── Redis cache ──────────────────────────────────────────────────────────
  // Key: per user + chat + searchKey scope.
  // Overrides (requestedTimeKey / requestedWordLength) are applied on top of
  // the cached result so we still avoid the expensive DB fan-out.
  const cacheKey = `smart_defaults:${userId}:${chatId}:${searchKey}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) {
      const parsed = JSON.parse(cached);
      if (requestedTimeKey) parsed.timeKey = requestedTimeKey;
      if (requestedWordLength) parsed.wordLength = requestedWordLength;
      return parsed;
    }
  } catch {}

  // ── Parallel batch 1: hasAnyScores + most-recent word length ────────────
  // These two queries are independent — run them together instead of serially.
  const [hasAnyRow, lengthRow] = await Promise.all([
    db
      .selectFrom("leaderboard")
      .select("userId")
      .where("userId", "=", userId)
      .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
      .limit(1)
      .executeTakeFirst(),

    db
      .selectFrom("leaderboard")
      .select("wordLength")
      .where("userId", "=", userId)
      .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirst(),
  ]);

  const hasAnyScores = !!hasAnyRow;
  const wordLength: AllowedWordLength =
    requestedWordLength ??
    (lengthRow ? (parseInt(lengthRow.wordLength) as AllowedWordLength) : 5);

  let timeKey: AllowedChatTimeKey = requestedTimeKey ?? "today";

  if (!requestedTimeKey && hasAnyScores) {
    // ── Parallel batch 2: all 4 period checks at once ─────────────────────
    // OLD: sequential loop — up to 4 DB round-trips (40–200ms)
    // NEW: one parallel batch — ~10–50ms regardless of how many periods fire
    const now = Date.now();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const checkPeriod = (fromDate: Date | null) =>
      db
        .selectFrom("leaderboard")
        .select("userId")
        .where("userId", "=", userId)
        .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
        .$if(fromDate !== null, (q) => q.where("createdAt", ">=", fromDate!))
        .limit(1)
        .executeTakeFirst();

    const [todayExists, weekExists, monthExists, yearExists] =
      await Promise.all([
        checkPeriod(todayStart),
        checkPeriod(new Date(now - 7 * 86_400_000)),
        checkPeriod(new Date(now - 30 * 86_400_000)),
        checkPeriod(new Date(now - 365 * 86_400_000)),
      ]);

    if (todayExists) timeKey = "today";
    else if (weekExists) timeKey = "week";
    else if (monthExists) timeKey = "month";
    else if (yearExists) timeKey = "year";
    else timeKey = "all";
  }

  const result = { searchKey, timeKey, wordLength, hasAnyScores };

  // Cache the result — fire-and-forget
  redis.set(cacheKey, JSON.stringify(result), "EX", SMART_DEFAULTS_TTL).catch(() => {});

  return result;
}
