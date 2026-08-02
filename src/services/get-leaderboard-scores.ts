import { sql } from "kysely";

import { db } from "../config/db";
import { AllowedWordLength } from "../config/constants";
import { AllowedChatSearchKey, AllowedChatTimeKey } from "../types";

export async function getLeaderboardScores({
  chatId,
  searchKey,
  timeKey,
  wordLength = 5,
}: {
  chatId: string;
  searchKey: AllowedChatSearchKey;
  timeKey: AllowedChatTimeKey;
  wordLength?: AllowedWordLength;
}) {
  let leaderboardQuery = db
    .selectFrom("leaderboard")
    .innerJoin("users", "users.id", "leaderboard.userId")
    .select((eb) => [
      "users.id as userId",
      "users.name as name",
      "users.username as username",
      sql<number>`cast(sum(${eb.ref("leaderboard.score")}) as integer)`.as(
        "totalScore",
      ),
    ])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("bannedUsers")
            .select("userId")
            .whereRef("bannedUsers.userId", "=", "leaderboard.userId"),
        ),
      ),
    )
    .groupBy("users.id")
    // Hide users whose net score is 0 or less (score was fully removed)
    .having(sql`sum(leaderboard.score)`, ">", 0)
    .orderBy(sql`sum(${sql.ref("leaderboard.score")}) desc`)
    .where(
      "leaderboard.wordLength",
      "=",
      wordLength.toString() as "4" | "5" | "6",
    )
    .limit(20);

  if (searchKey === "group") {
    leaderboardQuery = leaderboardQuery
      // Only scores earned in this specific chat
      .where("leaderboard.chatId", "=", chatId)
      // Exclude bot-mode virtual users by both ID formats:
      // numId format: 9900000001–9900000060 → matches "990000000%"
      // id format: "bot_001"–"bot_060"      → matches "bot_%"
      .where("users.id", "not like", "990000000%")
      .where("users.id", "not like", "bot_%");
  }

  if (searchKey === "global") {
    // Global: exclude "bot_mode" chatId so only real gameplay appears.
    // Bot-mode scores use chatId="bot_mode" — we keep them in global only.
    // (no extra filter needed — bot users are already in the users table
    //  and their scores show in global via the existing JOIN)
  }

  if (timeKey !== "all") {
    leaderboardQuery = leaderboardQuery.where((eb) => {
      if (timeKey === "today")
        return eb(
          sql`date_trunc('day', ${eb.ref("leaderboard.createdAt")})`,
          "=",
          sql<Date>`date_trunc('day', now())`,
        );
      else if (timeKey === "week")
        return eb(
          sql`date_trunc('week', ${eb.ref("leaderboard.createdAt")})`,
          "=",
          sql<Date>`date_trunc('week', now())`,
        );
      else if (timeKey === "month")
        return eb(
          sql`date_trunc('month', ${eb.ref("leaderboard.createdAt")})`,
          "=",
          sql<Date>`date_trunc('month', now())`,
        );
      else
        return eb(
          sql`date_trunc('year', ${eb.ref("leaderboard.createdAt")})`,
          "=",
          sql<Date>`date_trunc('year', now())`,
        );
    });
  }

  return await leaderboardQuery.execute();
}
