import { Composer } from "grammy";

import { redis } from "../config/redis";
import { CommandsHelper } from "../util/commands-helper";
import { requireAllowedTopic, runGuards } from "../util/guards";
import { getUserScores } from "../services/get-user-scores";
import { getLeaderboardScores } from "../services/get-leaderboard-scores";
import { parseLeaderboardFilters } from "../util/parse-leaderboard-input";
import { formatLeaderboardMessage } from "../util/format-leaderboard-message";
import { generateLeaderboardKeyboard } from "../util/generate-leaderboard-keyboard";

const composer = new Composer();

composer.command("leaderboard", async (ctx) => {
  const chatId = ctx.chat.id.toString();

  const guard = await runGuards(ctx, [requireAllowedTopic]);
  if (!guard.ok) return ctx.reply(guard.message);

  const { searchKey, timeKey, wordLength } = parseLeaderboardFilters(
    ctx.match,
    ctx.chat.type === "private" ? "global" : undefined,
  );

  const keyboard = generateLeaderboardKeyboard(searchKey, timeKey, wordLength);

  // Redis cache key — 60-second TTL so heavy GROUP BY query runs at most once/min
  const cacheKey = `lb:${chatId}:${searchKey}:${timeKey}:${wordLength}`;
  let memberScores: Awaited<ReturnType<typeof getLeaderboardScores>> | null = null;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) memberScores = JSON.parse(cached);
  } catch {}

  // Parallel: leaderboard (from cache or DB) + viewer's own rank
  const [freshScores, viewerScore] = await Promise.all([
    memberScores
      ? Promise.resolve(null)
      : getLeaderboardScores({ chatId, searchKey, timeKey, wordLength }),
    ctx.from
      ? getUserScores({
          userId: ctx.from.id.toString(),
          chatId,
          searchKey,
          timeKey,
          wordLength,
        })
      : Promise.resolve(undefined),
  ]);

  if (freshScores !== null) {
    memberScores = freshScores;
    redis.set(cacheKey, JSON.stringify(memberScores), "EX", 60).catch(() => {});
  }

  const viewerRank = viewerScore
    ? {
        rank: viewerScore.rank,
        totalScore: Number(viewerScore.totalScore),
        inTopList: (memberScores ?? []).some((m) => m.userId === viewerScore.id),
      }
    : null;

  // Fetch custom titles for top 3 users (fast Redis MGET pipeline)
  const top3 = (memberScores ?? []).slice(0, 3);
  const customTitles = new Map<string, string>();
  if (top3.length > 0) {
    const keys = top3.map((u) => `custom_title:${u.userId}`);
    const values = await redis.mget(...keys).catch(() => [] as (string | null)[]);
    for (let i = 0; i < top3.length; i++) {
      if (values[i]) customTitles.set(top3[i].userId, values[i]!);
    }
  }

  ctx.reply(formatLeaderboardMessage(memberScores ?? [], searchKey, viewerRank, customTitles), {
    disable_notification: true,
    reply_markup: keyboard,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
});

CommandsHelper.addNewCommand("leaderboard", "View the leaderboard.");

export const leaderboardCommand = composer;
