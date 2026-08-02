import { InlineKeyboard } from "grammy";

import { formatActiveButton } from "../commands/help";
import {
  AllowedWordLength,
  DISCUSSION_GROUP,
  UPDATES_CHANNEL,
} from "../config/constants";

type AllowedChatSearchKey = "global" | "group";
type AllowedChatTimeKey = "today" | "week" | "month" | "year" | "all";

const timeLabels: Record<AllowedChatTimeKey, string> = {
  today: "Today",
  week: "This week",
  month: "This month",
  year: "This year",
  all: "All time",
};

const scopeLabels: Record<AllowedChatSearchKey, string> = {
  global: "Global",
  group: "This chat",
};

/**
 * Leaderboard keyboard — active buttons show « label » (from formatActiveButton)
 * and use grammY's .style("primary") for actual blue highlight on supported clients.
 * No emoji prefixes — clean text-only distinction.
 */
export function generateLeaderboardKeyboard(
  searchKey: AllowedChatSearchKey,
  timeKey: AllowedChatTimeKey,
  wordLength: AllowedWordLength,
  prefix = "leaderboard",
  backButton?: { text: string; callback: string },
): InlineKeyboard {
  const kb = new InlineKeyboard();

  // ── Row 1: Scope + Refresh ───────────────────────────────────────────────
  const mid = Math.floor((["global", "group"] as AllowedChatSearchKey[]).length / 2);
  (["global", "group"] as AllowedChatSearchKey[]).forEach((s, index) => {
    if (index === mid && prefix === "leaderboard") {
      kb.text("🔄", `${prefix} ${searchKey} ${timeKey} ${wordLength}`);
    }
    kb.text(
      formatActiveButton(scopeLabels[s], s === searchKey),
      `${prefix} ${s} ${timeKey} ${wordLength}`,
    ).style(s === searchKey ? "primary" : undefined);
  });
  kb.row();

  // ── Row 2: Time filter (3 per row) ───────────────────────────────────────
  const timeKeys = ["today", "week", "month", "year", "all"] as AllowedChatTimeKey[];
  timeKeys.forEach((t, i) => {
    kb.text(
      formatActiveButton(timeLabels[t], t === timeKey),
      `${prefix} ${searchKey} ${t} ${wordLength}`,
    ).style(t === timeKey ? "primary" : undefined);
    if ((i + 1) % 3 === 0) kb.row();
  });
  kb.row();

  // ── Row 3: Word length ───────────────────────────────────────────────────
  for (const l of [4, 5, 6] as AllowedWordLength[]) {
    kb.text(
      formatActiveButton(`${l} letters`, l === wordLength),
      `${prefix} ${searchKey} ${timeKey} ${l}`,
    ).style(l === wordLength ? "primary" : undefined);
  }
  kb.row();

  // ── Links ────────────────────────────────────────────────────────────────
  kb.url("📢 Updates", UPDATES_CHANNEL).url("💬 Discussion", DISCUSSION_GROUP);

  // ── Back button (optional) ───────────────────────────────────────────────
  if (backButton) {
    kb.row().text(backButton.text, backButton.callback);
  }

  return kb;
}
