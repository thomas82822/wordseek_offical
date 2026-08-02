import { Composer, InputFile } from "grammy";

import { env } from "../config/env";
import { db } from "../config/db";
import { syncToGitHub } from "../services/github-sync";
import { CommandsHelper } from "../util/commands-helper";

const composer = new Composer();

composer.command("downloaddata", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply("⚠️ Use this command in my DM.");
  }

  const loadingMsg = await ctx.reply(
    "⏳ <b>Preparing data export...</b>",
    { parse_mode: "HTML" },
  );

  try {
    const [
      users,
      leaderboard,
      bannedUsers,
      botAdmins,
      frozenUsers,
      userStats,
      broadcastChats,
      userChats,
      games,
      guesses,
      authorizedUsers,
      chatGameTopics,
      dailyWords,
      dailyGuesses,
    ] = await Promise.all([
      db.selectFrom("users").selectAll().execute(),
      db.selectFrom("leaderboard").selectAll().execute(),
      db.selectFrom("bannedUsers").selectAll().execute(),
      db.selectFrom("botAdmins").selectAll().execute(),
      db.selectFrom("frozenUsers").selectAll().execute(),
      db.selectFrom("userStats").selectAll().execute(),
      db.selectFrom("broadcastChats").selectAll().execute(),
      db.selectFrom("userChats").selectAll().execute(),
      db.selectFrom("games").selectAll().execute(),
      db.selectFrom("guesses").selectAll().execute(),
      db.selectFrom("authorizedUsers").selectAll().execute(),
      db.selectFrom("chatGameTopics").selectAll().execute(),
      db.selectFrom("dailyWords").selectAll().execute(),
      db.selectFrom("dailyGuesses").selectAll().execute(),
    ]);

    const exportData = {
      exportedAt: new Date().toISOString(),
      counts: {
        users: users.length,
        leaderboard: leaderboard.length,
        bannedUsers: bannedUsers.length,
        botAdmins: botAdmins.length,
        frozenUsers: frozenUsers.length,
        userStats: userStats.length,
        broadcastChats: broadcastChats.length,
        userChats: userChats.length,
        games: games.length,
        guesses: guesses.length,
        authorizedUsers: authorizedUsers.length,
        chatGameTopics: chatGameTopics.length,
        dailyWords: dailyWords.length,
        dailyGuesses: dailyGuesses.length,
      },
      data: {
        users,
        leaderboard,
        bannedUsers,
        botAdmins,
        frozenUsers,
        userStats,
        broadcastChats,
        userChats,
        games,
        guesses,
        authorizedUsers,
        chatGameTopics,
        dailyWords,
        dailyGuesses,
      },
    };

    const json = JSON.stringify(exportData, null, 2);
    const buffer = Buffer.from(json, "utf-8");
    const filename = `wordseek-data-${new Date().toISOString().split("T")[0]}.json`;

    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

    await ctx.replyWithDocument(new InputFile(buffer, filename), {
      caption:
        `📦 <b>Full Data Export</b>\n\n` +
        `<blockquote>📅 Date: <code>${new Date().toLocaleDateString()}</code>\n` +
        `👤 Users: <code>${users.length}</code>\n` +
        `🏆 Leaderboard rows: <code>${leaderboard.length}</code>\n` +
        `🚫 Banned: <code>${bannedUsers.length}</code>\n` +
        `👑 Admins: <code>${botAdmins.length}</code>\n` +
        `❄️ Frozen: <code>${frozenUsers.length}</code>\n` +
        `📢 Broadcast chats: <code>${broadcastChats.length}</code>\n` +
        `👥 Known group users: <code>${userChats.length}</code>\n` +
        `🎮 Games: <code>${games.length}</code> · Guesses: <code>${guesses.length}</code>\n` +
        `📅 Daily words: <code>${dailyWords.length}</code> · Daily guesses: <code>${dailyGuesses.length}</code></blockquote>`,
      parse_mode: "HTML",
    });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    await ctx.reply(
      `❌ <b>Export Failed</b>\n\n<code>${err instanceof Error ? err.message : String(err)}</code>`,
      { parse_mode: "HTML" },
    );
  }
});

composer.command("syncgithub", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply("⚠️ Use this command in my DM.");
  }

  const msg = await ctx.reply(
    "⏳ <b>Downloading full GitHub repo...</b>\n<blockquote>Fetching all files from GitHub, please wait.</blockquote>",
    { parse_mode: "HTML" },
  );

  try {
    const owner = env.GITHUB_OWNER || "thomas82822";
    const repo  = env.GITHUB_REPO  || "wordseek_offical-";
    const branch = env.GITHUB_BRANCH || "main";

    // ── 1. Download ZIP archive of the entire repo ──────────────────────
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "WordSeekBot/1.0",
    };
    if (env.GITHUB_TOKEN) {
      headers["Authorization"] = `Bearer ${env.GITHUB_TOKEN}`;
    }

    const zipRes = await fetch(zipUrl, { headers });
    if (!zipRes.ok) {
      throw new Error(`GitHub responded ${zipRes.status} — ${await zipRes.text()}`);
    }

    const arrayBuf = await zipRes.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuf);
    const filename = `${repo}-${branch}-${new Date().toISOString().split("T")[0]}.zip`;
    const sizeMB = (zipBuffer.byteLength / 1_048_576).toFixed(2);

    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});

    await ctx.replyWithDocument(new InputFile(zipBuffer, filename), {
      caption:
        `📦 <b>Full Repo Download</b>\n\n` +
        `<blockquote>🔗 <code>${owner}/${repo}</code> @ <code>${branch}</code>\n` +
        `📅 Downloaded: <code>${new Date().toLocaleString()}</code>\n` +
        `💾 Size: <code>${sizeMB} MB</code>\n\n` +
        `Contains <b>all files</b> from the repository — no files skipped.</blockquote>`,
      parse_mode: "HTML",
    });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    await ctx.reply(
      `❌ <b>Download Failed</b>\n\n<code>${err instanceof Error ? err.message : String(err)}</code>`,
      { parse_mode: "HTML" },
    );
  }
});

CommandsHelper.addNewCommand("downloaddata", "Download all bot data as JSON (owner only)", true);
CommandsHelper.addNewCommand("syncgithub", "Manually sync data to GitHub (owner only)", true);

export const downloadDataCommand = composer;
