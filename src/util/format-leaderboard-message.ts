import type { AllowedChatSearchKey, LeaderboardEntry } from "../types";
import { pe } from "../config/constants";
import { escapeHtmlEntities } from "./escape-html-entities";
import { getTitleForScore } from "../config/title-config";

interface ViewerRank {
  rank: number;
  totalScore: number;
  inTopList: boolean;
}

// Specific premium emoji IDs for top 3 rank markers
const TOP_RANK_EMOJIS = [
  `<tg-emoji emoji-id="5440539497383087970">🥇</tg-emoji>`, // 1st
  `<tg-emoji emoji-id="5447203607294265305">🥈</tg-emoji>`, // 2nd
  `<tg-emoji emoji-id="5453902265922376865">🥉</tg-emoji>`, // 3rd
];

// Premium emoji for all other users
const OTHER_EMOJI = `<tg-emoji emoji-id="5001340866158136674">🔅</tg-emoji>`;

// Premium emoji for leaderboard header (both global and group)
const HEADER_EMOJI = `<tg-emoji emoji-id="5316979941181496594">🏆</tg-emoji>`;

// Premium title emojis shown next to milestone title — one per top-3 rank
const TITLE_EMOJIS = [
  `<tg-emoji emoji-id="6197058614608270294">✨</tg-emoji>`, // rank 1
  `<tg-emoji emoji-id="6195197807142376481">✨</tg-emoji>`, // rank 2
  `<tg-emoji emoji-id="5366313546156088619">✨</tg-emoji>`, // rank 3
];

export function formatLeaderboardMessage(
  data: LeaderboardEntry[],
  searchKey: AllowedChatSearchKey,
  viewerRank?: ViewerRank | null,
  /** Custom titles keyed by userId — overrides score-based title */
  customTitles?: Map<string, string>,
) {
  const blocks = data.reduce((acc, entry, index) => {
    const rank = index < 3 ? TOP_RANK_EMOJIS[index] : OTHER_EMOJI;

    let usernameLink = escapeHtmlEntities(entry.name);
    if (entry.username) {
      usernameLink = `<a href="t.me/${entry.username}">${escapeHtmlEntities(
        entry.name,
      )}</a>`;
    }

    // Title shown for all top-3 positions — custom title takes priority
    let titlePart = "";
    if (index < 3) {
      const customTitle = customTitles?.get(entry.userId);
      const scoreTitle = getTitleForScore(entry.totalScore);
      const title = customTitle ?? scoreTitle;
      if (title) {
        // Hard highlight — bold, decorated, on its own line below the score row
        titlePart = `\n   ${TITLE_EMOJIS[index]} <b>「${escapeHtmlEntities(title)}」</b>`;
      }
    }

    const scoreLine = `${rank}${usernameLink} — ${entry.totalScore.toLocaleString()} pts${titlePart}`;

    if (index === 0 || index === 3 || (index > 3 && (index - 3) % 10 === 0)) {
      acc.push([]);
    }
    acc[acc.length - 1].push(scoreLine);

    return acc;
  }, [] as string[][]);

  const formattedEntries = blocks
    .map((block) => `<blockquote>${block.join("\n")}</blockquote>`)
    .join("\n");

  const header = `<blockquote>${HEADER_EMOJI} ${
    searchKey === "global" ? "Global" : "Group"
  } Leaderboard ${HEADER_EMOJI}</blockquote>\n\n${formattedEntries}`;

  if (viewerRank && !viewerRank.inTopList) {
    return (
      header +
      `\n\n<blockquote>${pe("📍")} Your Rank: <b>#${viewerRank.rank}</b> — ${viewerRank.totalScore.toLocaleString()} pts</blockquote>`
    );
  }

  return header;
}
