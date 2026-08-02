import { db } from "../config/db";
import { AllowedWordLength } from "../config/constants";

type AllowedChatSearchKey = "global" | "group";
type AllowedChatTimeKey = "today" | "week" | "month" | "year" | "all";

const TIME_KEYS: AllowedChatTimeKey[] = ["today", "week", "month", "year", "all"];

interface SmartDefaultsParams {
  userId: string;
  chatId: string;
  requestedSearchKey?: AllowedChatSearchKey;
  requestedTimeKey?: AllowedChatTimeKey;
  chatType?: string;
}

export async function getSmartDefaults({
  userId,
  chatId,
  requestedSearchKey,
  requestedTimeKey,
  chatType,
}: SmartDefaultsParams) {
  const isPrivate = chatType === "private";
  const searchKey: AllowedChatSearchKey = requestedSearchKey ?? (isPrivate ? "global" : "group");

  const hasAnyRow = await db
    .selectFrom("leaderboard")
    .select("userId")
    .where("userId", "=", userId)
    .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
    .limit(1)
    .executeTakeFirst();

  const hasAnyScores = !!hasAnyRow;
  let timeKey: AllowedChatTimeKey = requestedTimeKey ?? "today";

  if (!requestedTimeKey && hasAnyScores) {
    for (const period of TIME_KEYS) {
      const now = new Date();
      let fromDate: Date | null = null;

      if (period === "today") { fromDate = new Date(now.setHours(0, 0, 0, 0)); }
      else if (period === "week") { fromDate = new Date(Date.now() - 7 * 86400000); }
      else if (period === "month") { fromDate = new Date(Date.now() - 30 * 86400000); }
      else if (period === "year") { fromDate = new Date(Date.now() - 365 * 86400000); }

      const exists = await db
        .selectFrom("leaderboard")
        .select("userId")
        .where("userId", "=", userId)
        .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
        .$if(fromDate !== null, (q) => q.where("createdAt", ">=", fromDate!))
        .limit(1)
        .executeTakeFirst();

      if (exists) { timeKey = period; break; }
    }
  }

  const lengthRow = await db
    .selectFrom("leaderboard")
    .select("wordLength")
    .where("userId", "=", userId)
    .$if(searchKey === "group", (q) => q.where("chatId", "=", chatId))
    .orderBy("createdAt", "desc")
    .limit(1)
    .executeTakeFirst();

  const wordLength: AllowedWordLength = lengthRow
    ? (parseInt(lengthRow.wordLength) as AllowedWordLength)
    : 5;

  return { searchKey, timeKey, wordLength, hasAnyScores };
}
