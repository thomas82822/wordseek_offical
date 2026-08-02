import {
  allowedChatSearchKeys,
  allowedChatTimeKeys,
  allowedWordLengths,
  AllowedWordLength,
} from "../config/constants";
import { AllowedChatSearchKey, AllowedChatTimeKey } from "../types";

interface ParsedLeaderboardFilters {
  searchKey?: AllowedChatSearchKey;
  timeKey?: AllowedChatTimeKey;
  wordLength?: AllowedWordLength;
}

function extractFilters(tokens: string[]): {
  filters: ParsedLeaderboardFilters;
  rest: string[];
} {
  const filters: ParsedLeaderboardFilters = {};
  const rest: string[] = [];

  for (const rawToken of tokens) {
    const token = rawToken.trim();
    if (!token) continue;

    const lower = token.toLowerCase();

    if ((allowedChatSearchKeys as readonly string[]).includes(lower)) {
      filters.searchKey = lower as AllowedChatSearchKey;
      continue;
    }

    if ((allowedChatTimeKeys as readonly string[]).includes(lower)) {
      filters.timeKey = lower as AllowedChatTimeKey;
      continue;
    }

    const asNumber = Number(lower);
    if (
      !Number.isNaN(asNumber) &&
      (allowedWordLengths as readonly number[]).includes(asNumber)
    ) {
      filters.wordLength = asNumber as AllowedWordLength;
      continue;
    }

    rest.push(token);
  }

  return { filters, rest };
}

// Used by /leaderboard — no target user, just filters.
export function parseLeaderboardFilters(
  input: string,
  defaultSearchKey?: AllowedChatSearchKey,
): {
  searchKey: AllowedChatSearchKey;
  timeKey: AllowedChatTimeKey;
  wordLength: AllowedWordLength;
} {
  const tokens = (input ?? "").trim().split(/\s+/).filter(Boolean);
  const { filters } = extractFilters(tokens);

  return {
    searchKey: filters.searchKey ?? defaultSearchKey ?? "group",
    timeKey: filters.timeKey ?? "today",
    wordLength: filters.wordLength ?? 5,
  };
}

// Used by /score — may also contain a target username/id.
export function parseLeaderboardInput(
  input: string,
  defaultSearchKey?: AllowedChatSearchKey,
  defaultTimeKey?: AllowedChatTimeKey | null,
): {
  target: string | null;
  searchKey?: AllowedChatSearchKey;
  timeKey?: AllowedChatTimeKey;
  wordLength?: AllowedWordLength;
} {
  const tokens = (input ?? "").trim().split(/\s+/).filter(Boolean);
  const { filters, rest } = extractFilters(tokens);

  const target = rest.length > 0 ? rest.join(" ") : null;

  return {
    target,
    searchKey: filters.searchKey ?? defaultSearchKey,
    timeKey: filters.timeKey ?? defaultTimeKey ?? undefined,
    wordLength: filters.wordLength,
  };
}
