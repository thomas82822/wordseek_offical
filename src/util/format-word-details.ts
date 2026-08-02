import { pe } from "../config/constants";

interface WordDetails {
  word: string;
  meaning: string | null;
  phonetic: string | null;
  sentence: string | null;
}

export function formatDailyWordDetails(word: WordDetails): string {
  let msg = `<b>${pe("📖")} Word Details: ${word.word.toUpperCase()}</b>`;
  if (word.phonetic) msg += `\n\n${pe("🔊")} <i>${word.phonetic}</i>`;
  if (word.meaning) msg += `\n\n${pe("📝")} <b>Meaning:</b>\n${word.meaning}`;
  if (word.sentence) msg += `\n\n${pe("💬")} <b>Example:</b>\n<i>${word.sentence}</i>`;
  return msg;
}
