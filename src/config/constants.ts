export const UPDATES_CHANNEL = "https://t.me/ApexAssociation";
export const DISCUSSION_GROUP = "https://t.me/+PeQ3i4IEnBdmZTdl";
export const CHANNEL_LINK = "https://t.me/ApexAssociation";
export const OWNER_LINK = "https://t.me/TheY_CaIl_mE_OG";

export const allowedChatSearchKeys = ["global", "group"] as const;
export const allowedChatTimeKeys = [
  "today",
  "week",
  "month",
  "year",
  "all",
] as const;

export type AllowedWordLength = 4 | 5 | 6;
export const allowedWordLengths: AllowedWordLength[] = [4, 5, 6];

export const SLOT_SYMBOLS = ["➖", "🍒", "🍋", "7️⃣"];

// ── Premium Custom Emoji IDs ─────────────────────────────────────────────────
export const PREMIUM_EMOJI_IDS = [
  "6172738808971268732",
  "4929483658114368660",
  "6001569493048891375",
  "6303210599639684218",
  "5999337402840127790",
  "6073220916324602224",
  "5244863909818571734",
  "6073454283372630712",
  "6075839983086736035",
  "6174884334114182449",
  "6199293238847740460",
  "6125399112499075549",
  "6136164675659766791",
  "6124898345082165755",
  "6303333259610691279",
  "6275794758237426356",
  "6208470235339560785",
  "6127636064610818291",
  "6122730271360946438",
  "6123129707614441341",
  "5188451807898131583",
  "6172473603330675315",
  "6172467470117376317",
  "6172313014503479475",
  "6172370910662628916",
  "6172553768895256106",
  "5188385214430209713",
  "5188221335658064259",
  "6120953460570460166",
  "6120648298849112199",
  "6123205406413033871",
  "6120721519451574392",
  "14047402874",
];

/** Returns a random premium emoji HTML tag for use in messages */
export function randomPremiumEmoji(): string {
  const id =
    PREMIUM_EMOJI_IDS[Math.floor(Math.random() * PREMIUM_EMOJI_IDS.length)];
  return `<tg-emoji emoji-id="${id}">⭐</tg-emoji>`;
}

// ── Deterministic emoji → premium emoji mapping ──────────────────────────────
// Every distinct fallback emoji always maps to the same premium custom-emoji
// id (stable across restarts), so the same icon always looks the same for
// users instead of changing randomly on every message.
//
// IMPORTANT: never wrap the game-board feedback squares (🟥 🟨 🟩) or the
// bold unicode letter-tile text with this — those must render as plain text.
const fallbackToPremiumId = new Map<string, string>();

function premiumIdFor(fallback: string): string {
  let cached = fallbackToPremiumId.get(fallback);
  if (!cached) {
    let hash = 0;
    for (const ch of fallback) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
    cached = PREMIUM_EMOJI_IDS[hash % PREMIUM_EMOJI_IDS.length];
    fallbackToPremiumId.set(fallback, cached);
  }
  return cached;
}

/**
 * Wraps a decorative emoji as a Telegram premium/custom emoji for use inside
 * HTML-parsed message text (requires `parse_mode: "HTML"` on the reply).
 *
 * Do NOT use this on inline keyboard button text (Telegram buttons render
 * plain text only, custom emoji tags won't work there and aren't wanted per
 * product requirements) or on the 🟥🟨🟩 game feedback tiles / fancy letter
 * tile text.
 */
export function pe(fallback: string): string {
  return `<tg-emoji emoji-id="${premiumIdFor(fallback)}">${fallback}</tg-emoji>`;
}

export const SYSTEM_PROMPT = `
You are an expert English word master. Your task is to provide detailed information about a specific English word.

For the given word, generate the following:

1. **Meaning** — Provide a clear, thorough explanation of the word.
   - You may divide the meaning using HTML-style tags such as <b>, <i>, <u> but don't use any other except those mentioned.
   - You may include multiple senses or nuances of the word.
   - The meaning should be descriptive and helpful for learners.
   - The meaning length must not exceed 900 characters.

2. **Phonetic** — Provide the standard IPA pronunciation.

3. **Sentence** — Provide one example sentence that correctly uses the provided word.

Your output must be in **strict JSON format** as follows:
{
  "word": "the provided word",
  "phonetic": "IPA pronunciation",
  "meaning": "descriptive meaning, with optional <b> <i> <u> tags",
  "sentence": "an example sentence correctly using the provided word"
}

**Important Rules:**
1. The meaning must never include unrelated commentary or instructions.
2. Output strictly as JSON **without backticks, code blocks, comments, or extra formatting**.
3. Do not add explanations outside of the JSON.
`;
