import { pe } from "../config/constants";

type AllowedChatSearchKey = "global" | "group";

interface UserScore {
  name: string;
  userId: string;
  totalScore: number;
  gamesWon: number;
  avgScore: number;
  bestScore: number;
  wordLength?: number;
  rank?: number;
}

export function formatUserScoreMessage(score: UserScore, searchKey: AllowedChatSearchKey): string {
  const scopeLabel = searchKey === "global" ? `${pe("🌍")} Global` : `${pe("👥")} Group`;
  const name = score.name?.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") ?? "Unknown";
  const rankLine = score.rank ? `${pe("📍")} Rank: <code>#${score.rank}</code>\n` : "";

  return (
    `<b>${pe("📊")} Score for ${name}</b>\n\n` +
    `<blockquote>${scopeLabel} | ${score.wordLength ?? 5}-letter mode\n\n` +
    rankLine +
    `${pe("🏆")} Total Score: <code>${Number(score.totalScore).toLocaleString()}</code>\n` +
    `${pe("🎮")} Games Won: <code>${Number(score.gamesWon).toLocaleString()}</code>\n` +
    `${pe("⭐")} Best Score: <code>${Number(score.bestScore).toLocaleString()}</code>\n` +
    `${pe("📈")} Avg Score: <code>${Number(score.avgScore).toFixed(1)}</code></blockquote>`
  );
}
