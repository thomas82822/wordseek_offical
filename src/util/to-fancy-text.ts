/**
 * Converts A–Z / a–z to Unicode bold sans-serif (𝗔–𝗭 / 𝗮–𝘇).
 * Emojis, spaces, newlines, and symbols are left untouched.
 */
export function toFancyText(text: string): string {
  // Bold sans-serif uppercase A = U+1D5D4, lowercase a = U+1D5EE
  return [...text]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d5d4 + (code - 65)); // A–Z
      if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d5ee + (code - 97)); // a–z
      return ch;
    })
    .join("");
}
