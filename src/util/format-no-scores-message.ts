import { pe } from "../config/constants";

type AllowedChatSearchKey = "global" | "group";
type AllowedChatTimeKey = "today" | "week" | "month" | "year" | "all";

interface Params {
  isOwnScore: boolean;
  userName: string;
  searchKey: AllowedChatSearchKey;
  timeKey: AllowedChatTimeKey;
  wasTimeKeyExplicit: boolean;
  hasAnyScores: boolean;
}

export function formatNoScoresMessage({ isOwnScore, userName, searchKey, timeKey, hasAnyScores }: Params): string {
  const scope = searchKey === "global" ? "globally" : "in this group";
  const subject = isOwnScore ? "You have" : `${userName} has`;
  const hint = hasAnyScores
    ? "Try a different time period or scope."
    : `${isOwnScore ? "You haven't" : `${userName} hasn't`} played any games yet.`;

  return (
    `<b>${pe("📊")} No Scores Found</b>\n\n` +
    `<blockquote>${subject} no scores ${scope} for <b>${timeKey}</b>.\n\n${hint}</blockquote>`
  );
}
