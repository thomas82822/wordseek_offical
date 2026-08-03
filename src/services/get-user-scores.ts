import { sql } from "kysely";

import { db } from "../config/db";
import { redis } from "../config/redis";
import { AllowedWordLength } from "../config/constants";
import type { AllowedChatSearchKey, AllowedChatTimeKey } from "../types";

export async function getUserScores({
  chatId,
  searchKey,
  userId,
  timeKey,
  wordLength = 5,
}: {
  chatId: string;
  searchKey: AllowedChatSearchKey;
  userId: string;
  timeKey: AllowedChatTimeKey;
  wordLength?: AllowedWordLength;
}) {
  // ── Redis cache ──────────────────────────────────────────────────────────
  // getUserScores runs a window function (rank() over …) that scans the full
  // leaderboard. With no caching, every /score or /leaderboard call pays this
  // cost. A 60-second TTL means scores are at most 60 s stale — fine for a
  // game leaderboard, and unnoticeable to users.
  const cacheKey = `user_score:${userId}:${chatId}:${searchKey}:${timeKey}:${wordLength}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return JSON.parse(cached) ?? undefined;
  } catch {}

  const userQuery = db
    .selectFrom((eb) => {
      let innerQuery = eb
        .selectFrom("leaderboard")
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
        .select("leaderboard.userId")
        .select(sql<number>`sum(leaderboard.score)`.as("totalScore"))
        .groupBy("leaderboard.userId")
        .select(
          sql<number>`rank() over (order by sum(leaderboard.score) desc)`.as(
            "rank",
          ),
        )
        .where(
          "leaderboard.wordLength",
          "=",
          wordLength.toString() as "4" | "5" | "6",
        );

      if (searchKey === "group") {
        innerQuery = innerQuery.where("leaderboard.chatId", "=", chatId);
      }

      if (timeKey !== "all") {
        innerQuery = innerQuery.where((eb) => {
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

      return innerQuery.as("lb");
    })
    .innerJoin("users", "users.id", "lb.userId")
    .leftJoin("userStats", "userStats.userId", "users.id")
    .select([
      "users.id",
      "users.name",
      "users.username",
      "lb.totalScore",
      "lb.rank",
      "userStats.highestStreak",
      "userStats.currentStreak",
    ])
    .where("users.id", "=", userId);

  const result = await userQuery.executeTakeFirst();

  // Cache the result (including null → store as JSON null so we know it's a
  // cache hit for "no scores" rather than a cache miss).
  redis
    .set(cacheKey, JSON.stringify(result ?? null), "EX", 60)
    .catch(() => {});

  return result;
}
