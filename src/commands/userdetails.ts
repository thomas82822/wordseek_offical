/**
 * /userdetails <user_id> — Owner only (DM only)
 * Shows comprehensive details about a user:
 * - Basic profile info
 * - All group chats they've been seen in
 * - Win/score breakdown per chat and word length
 * - Games started by this user
 * - Win timing stats (first win, last win, best score, avg score)
 */

import { Composer } from "grammy";
import { sql } from "kysely";

import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString();
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-IN", {
      timeZone: env.TIME_ZONE || "Asia/Kolkata",
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(d);
  }
}

composer.command("userdetails", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply("⚠️ Use this command in my DM.");
  }

  const args = ctx.message?.text?.split(" ").slice(1) ?? [];
  const targetId = args[0]?.trim();

  if (!targetId) {
    return ctx.reply(
      `${pe("ℹ️")} <b>Usage:</b> <code>/userdetails &lt;user_id&gt;</code>\n\n` +
        `Example: <code>/userdetails 123456789</code>`,
      { parse_mode: "HTML" },
    );
  }

  const loadingMsg = await ctx.reply(
    `⏳ <b>Fetching details for <code>${targetId}</code>...</b>`,
    { parse_mode: "HTML" },
  );

  try {
    // ── Parallel fetch: user info + chats + leaderboard + games started ──
    const [
      userInfo,
      userChats,
      leaderboardRows,
      gamesStarted,
      totalWins,
      totalScore,
      bestScore,
      firstWin,
      lastWin,
    ] = await Promise.all([
      // Basic user record
      db.selectFrom("users")
        .selectAll()
        .where("id", "=", targetId)
        .executeTakeFirst(),

      // Group chats the user has been seen in
      db.selectFrom("userChats")
        .selectAll()
        .where("userId", "=", targetId)
        .orderBy("lastSeenAt", "desc")
        .execute(),

      // Leaderboard entries grouped by chatId + wordLength
      db.selectFrom("leaderboard")
        .select([
          "chatId",
          "wordLength",
          sql<number>`cast(count(*) as integer)`.as("wins"),
          sql<number>`cast(sum(score) as integer)`.as("totalScore"),
          sql<number>`cast(max(score) as integer)`.as("bestScore"),
          sql<number>`cast(avg(score) as float)`.as("avgScore"),
          sql<string>`min(cast("createdAt" as text))`.as("firstWin"),
          sql<string>`max(cast("createdAt" as text))`.as("lastWin"),
        ])
        .where("userId", "=", targetId)
        .groupBy(["chatId", "wordLength"])
        .orderBy("totalScore", "desc")
        .execute(),

      // Games this user started
      db.selectFrom("games")
        .select([
          "activeChat",
          "topicId",
          "word",
          "startedBy",
          "createdAt",
        ])
        .where("startedBy", "=", targetId)
        .orderBy("createdAt", "desc")
        .limit(10)
        .execute(),

      // Aggregate: total wins
      db.selectFrom("leaderboard")
        .select(sql<number>`cast(count(*) as integer)`.as("count"))
        .where("userId", "=", targetId)
        .executeTakeFirst(),

      // Aggregate: total score
      db.selectFrom("leaderboard")
        .select(sql<number>`cast(sum(score) as integer)`.as("total"))
        .where("userId", "=", targetId)
        .executeTakeFirst(),

      // Aggregate: best score
      db.selectFrom("leaderboard")
        .select(sql<number>`cast(max(score) as integer)`.as("best"))
        .where("userId", "=", targetId)
        .executeTakeFirst(),

      // First ever win
      db.selectFrom("leaderboard")
        .select(["createdAt", "chatId", "wordLength", "score"])
        .where("userId", "=", targetId)
        .orderBy("createdAt", "asc")
        .limit(1)
        .executeTakeFirst(),

      // Last win
      db.selectFrom("leaderboard")
        .select(["createdAt", "chatId", "wordLength", "score"])
        .where("userId", "=", targetId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);

    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    // ── Build the response ────────────────────────────────────────────────
    const winCount = Number(totalWins?.count ?? 0);
    const scoreTotal = Number(totalScore?.total ?? 0);
    const best = Number(bestScore?.best ?? 0);
    const avgScore = winCount > 0 ? (scoreTotal / winCount).toFixed(1) : "—";

    let msg = `${pe("🔍")} <b>User Details</b>\n\n`;

    // ── Section 1: Profile ────────────────────────────────────────────────
    msg += `<blockquote>${pe("👤")} <b>Profile</b>\n`;
    msg += `├ ID: <code>${targetId}</code>\n`;
    if (userInfo) {
      const displayName = userInfo.name || "—";
      const username = userInfo.username ? `@${userInfo.username}` : "none";
      msg += `├ Name: <b>${displayName}</b>\n`;
      msg += `├ Username: ${username}\n`;
    } else {
      msg += `├ Name: <i>Not in users table</i>\n`;
    }
    msg += `└ Groups seen in: <b>${userChats.length}</b></blockquote>\n\n`;

    // ── Section 2: Win Stats ──────────────────────────────────────────────
    msg += `<blockquote>${pe("🏆")} <b>Win Stats</b>\n`;
    msg += `├ Total Wins: <b>${fmt(winCount)}</b>\n`;
    msg += `├ Total Score: <b>${fmt(scoreTotal)}</b>\n`;
    msg += `├ Best Score: <b>${fmt(best)}</b>\n`;
    msg += `├ Avg Score/Win: <b>${avgScore}</b>\n`;
    msg += `├ First Win: <code>${fmtDate(firstWin?.createdAt)}</code>`;
    if (firstWin) msg += ` (+${firstWin.score} · ${firstWin.wordLength}L)`;
    msg += `\n`;
    msg += `└ Last Win: <code>${fmtDate(lastWin?.createdAt)}</code>`;
    if (lastWin) msg += ` (+${lastWin.score} · ${lastWin.wordLength}L)`;
    msg += `</blockquote>\n\n`;

    // ── Section 3: Group Chats ────────────────────────────────────────────
    if (userChats.length > 0) {
      msg += `<blockquote>${pe("💬")} <b>Group Chats (${userChats.length})</b>\n`;
      const showChats = userChats.slice(0, 8);
      for (const uc of showChats) {
        const title = uc.chatTitle || uc.chatId;
        const last = fmtDate(uc.lastSeenAt);
        msg += `• <b>${title}</b> (<code>${uc.chatId}</code>)\n  Last seen: <code>${last}</code>\n`;
      }
      if (userChats.length > 8) {
        msg += `<i>…and ${userChats.length - 8} more</i>\n`;
      }
      msg += `</blockquote>\n\n`;
    } else {
      msg += `<blockquote>${pe("💬")} <b>Group Chats</b>\nNo group activity recorded.</blockquote>\n\n`;
    }

    // ── Section 4: Wins by Chat ───────────────────────────────────────────
    if (leaderboardRows.length > 0) {
      msg += `<blockquote>${pe("📊")} <b>Wins by Chat &amp; Mode</b>\n`;
      // Group by chatId for display
      const byChatId: Record<string, typeof leaderboardRows> = {};
      for (const row of leaderboardRows) {
        if (!byChatId[row.chatId]) byChatId[row.chatId] = [];
        byChatId[row.chatId].push(row);
      }
      const chatIds = Object.keys(byChatId).slice(0, 5);
      for (const cid of chatIds) {
        const chatTitle = userChats.find((uc) => uc.chatId === cid)?.chatTitle || cid;
        const rows = byChatId[cid];
        const chatWins = rows.reduce((s, r) => s + Number(r.wins), 0);
        const chatScore = rows.reduce((s, r) => s + Number(r.totalScore), 0);
        msg += `\n<b>${chatTitle}</b> — ${fmt(chatWins)} wins · ${fmt(chatScore)} pts\n`;
        for (const r of rows) {
          const first = fmtDate(r.firstWin);
          const last2 = fmtDate(r.lastWin);
          msg += `  ${r.wordLength}L: ${fmt(Number(r.wins))} wins · best ${fmt(Number(r.bestScore))} · avg ${Number(r.avgScore).toFixed(1)}\n`;
          msg += `     First: <code>${first}</code>  Last: <code>${last2}</code>\n`;
        }
      }
      if (Object.keys(byChatId).length > 5) {
        msg += `\n<i>…and ${Object.keys(byChatId).length - 5} more chats</i>\n`;
      }
      msg += `</blockquote>\n\n`;
    }

    // ── Section 5: Recently Started Games ────────────────────────────────
    if (gamesStarted.length > 0) {
      msg += `<blockquote>${pe("🎮")} <b>Recently Started Games (last ${gamesStarted.length})</b>\n`;
      for (const g of gamesStarted) {
        const chatLabel = g.activeChat;
        const dt = fmtDate(g.createdAt);
        const wordLen = g.word?.length ?? "?";
        msg += `• Chat <code>${chatLabel}</code> · ${wordLen}L · <code>${dt}</code>\n`;
      }
      msg += `</blockquote>`;
    } else {
      msg += `<blockquote>${pe("🎮")} <b>Started Games</b>\nNo games started by this user.</blockquote>`;
    }

    // Split if too long for one message
    const MAX = 4000;
    if (msg.length <= MAX) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    } else {
      // Send in two parts
      const mid = msg.lastIndexOf("\n\n", MAX);
      await ctx.reply(msg.slice(0, mid), { parse_mode: "HTML" });
      await ctx.reply(msg.slice(mid).trimStart(), { parse_mode: "HTML" });
    }
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply(
      `❌ <b>Failed to fetch details</b>\n\n<code>${err instanceof Error ? err.message : String(err)}</code>`,
      { parse_mode: "HTML" },
    );
  }
});

CommandsHelper.addNewCommand("userdetails", "View full details of a user (owner only)", true);

export const userDetailsCommand = composer;
