/**
 * Logging service — sends structured notifications to LOGS_CHANNEL.
 * Used for bonus claim requests, transfer requests, and all game events.
 */

import { InlineKeyboard } from "grammy";

import { bot } from "../config/bot";
import { env } from "../config/env";

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function userMention(user: { id: string; name: string; username: string | null }) {
  return user.username
    ? `@${user.username}`
    : `<a href="tg://user?id=${user.id}">${escHtml(user.name)}</a>`;
}

function fmtNow(): string {
  try {
    return new Date().toLocaleString("en-IN", {
      timeZone: env.TIME_ZONE || "Asia/Kolkata",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return new Date().toISOString();
  }
}

// ── Game Event Logs ───────────────────────────────────────────────────────────

/** Log when a new game is started */
export async function logGameStarted(params: {
  chatId: string;
  chatTitle: string | null;
  user: { id: string; name: string; username: string | null };
  wordLength: number;
  gameId?: number;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;
  const { chatId, chatTitle, user, wordLength, gameId } = params;
  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `🎮 <b>Game Started</b>\n\n` +
        `<blockquote>👤 By: ${userMention(user)} (<code>${user.id}</code>)\n` +
        `💬 Chat: <b>${escHtml(chatTitle ?? chatId)}</b> (<code>${chatId}</code>)\n` +
        `🔤 Mode: <b>${wordLength}-letter</b>\n` +
        (gameId != null ? `🆔 Game ID: <code>${gameId}</code>\n` : "") +
        `🕐 Time: <code>${fmtNow()}</code></blockquote>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

/** Log when a game is won (correct guess) */
export async function logGameWon(params: {
  chatId: string;
  chatTitle: string | null;
  user: { id: string; name: string; username: string | null };
  word: string;
  score: number;
  guessCount: number;
  wordLength: number;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;
  const { chatId, chatTitle, user, word, score, guessCount, wordLength } = params;
  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `🏆 <b>Game Won!</b>\n\n` +
        `<blockquote>👤 Winner: ${userMention(user)} (<code>${user.id}</code>)\n` +
        `💬 Chat: <b>${escHtml(chatTitle ?? chatId)}</b> (<code>${chatId}</code>)\n` +
        `🔤 Word: <b>${escHtml(word.toUpperCase())}</b> (${wordLength}L)\n` +
        `💯 Score: <b>+${score}</b> pts\n` +
        `🔢 Guesses used: <b>${guessCount}/30</b>\n` +
        `🕐 Time: <code>${fmtNow()}</code></blockquote>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

/** Log when game ends after 30 guesses (nobody won) */
export async function logGameOver(params: {
  chatId: string;
  chatTitle: string | null;
  word: string;
  wordLength: number;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;
  const { chatId, chatTitle, word, wordLength } = params;
  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `💀 <b>Game Over — No Winner</b>\n\n` +
        `<blockquote>💬 Chat: <b>${escHtml(chatTitle ?? chatId)}</b> (<code>${chatId}</code>)\n` +
        `🔤 Word was: <b>${escHtml(word.toUpperCase())}</b> (${wordLength}L)\n` +
        `🔢 All 30 guesses used\n` +
        `🕐 Time: <code>${fmtNow()}</code></blockquote>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

/** Log when a game is ended manually via /end */
export async function logGameEnded(params: {
  chatId: string;
  chatTitle: string | null;
  user: { id: string; name: string; username: string | null };
  word: string;
  wordLength: number;
  reason: string;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;
  const { chatId, chatTitle, user, word, wordLength, reason } = params;
  // Strip HTML tags from reason for clean log display
  const cleanReason = reason.replace(/<[^>]*>/g, "");
  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `🛑 <b>Game Ended Manually</b>\n\n` +
        `<blockquote>👤 By: ${userMention(user)} (<code>${user.id}</code>)\n` +
        `💬 Chat: <b>${escHtml(chatTitle ?? chatId)}</b> (<code>${chatId}</code>)\n` +
        `🔤 Word was: <b>${escHtml(word.toUpperCase())}</b> (${wordLength}L)\n` +
        `📝 Reason: ${escHtml(cleanReason)}\n` +
        `🕐 Time: <code>${fmtNow()}</code></blockquote>`,
      { parse_mode: "HTML" },
    )
    .catch(() => {});
}

// ── Bonus Claim ───────────────────────────────────────────────────────────────

export async function logBonusClaimRequest(params: {
  requestId: number;
  user: { id: string; name: string; username: string | null };
  bonusScore: number;
  highestSource: number;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;

  const { requestId, user, bonusScore, highestSource } = params;

  const kb = new InlineKeyboard()
    .text("✅ Approve", `bonus_approve ${requestId}`)
    .text("❌ Reject", `bonus_reject ${requestId}`);

  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `🎁 <b>Bonus Claim Request</b>\n\n` +
        `<blockquote>👤 User: ${userMention(user)} (<code>${user.id}</code>)\n` +
        `💰 Bonus: <code>${bonusScore.toLocaleString()}</code> pts\n` +
        `📊 Total Score: <code>${highestSource.toLocaleString()}</code>\n` +
        `🆔 Request ID: <code>${requestId}</code></blockquote>`,
      { parse_mode: "HTML", reply_markup: kb },
    )
    .catch(() => {});
}

// ── Transfer Request ──────────────────────────────────────────────────────────

export async function logTransferRequest(params: {
  requestId: number;
  fromUser: { id: string; name: string; username: string | null };
  toUser: { id: string; name: string; username: string | null };
  totalScore: number;
}): Promise<void> {
  if (!env.LOGS_CHANNEL) return;

  const { requestId, fromUser, toUser, totalScore } = params;

  const kb = new InlineKeyboard()
    .text("✅ Approve", `transfer_approve ${requestId}`)
    .text("❌ Reject", `transfer_reject ${requestId}`);

  await bot.api
    .sendMessage(
      env.LOGS_CHANNEL,
      `📤 <b>Score Transfer Request</b>\n\n` +
        `<blockquote>📤 From: ${userMention(fromUser)} (<code>${fromUser.id}</code>)\n` +
        `📥 To: ${userMention(toUser)} (<code>${toUser.id}</code>)\n` +
        `💯 Score: <code>${totalScore.toLocaleString()}</code>\n` +
        `🆔 Request ID: <code>${requestId}</code></blockquote>`,
      { parse_mode: "HTML", reply_markup: kb },
    )
    .catch(() => {});
}
