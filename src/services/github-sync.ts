import { CronJob } from "cron";

import { db } from "../config/db";
import { env } from "../config/env";

const BASE_URL = "https://api.github.com";

interface GitHubFileResponse {
  sha: string;
  content: string;
  encoding: string;
}

async function ghFetch(path: string, options: RequestInit = {}) {
  if (!env.GITHUB_TOKEN) return null;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function getFileSha(filePath: string): Promise<string | null> {
  try {
    const res = await ghFetch(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}?ref=${env.GITHUB_BRANCH}`,
    );
    if (!res || !res.ok) return null;
    const data = (await res.json()) as GitHubFileResponse;
    return data.sha || null;
  } catch {
    return null;
  }
}

/**
 * Push raw binary content (e.g. an image) to GitHub via the Contents API.
 */
export async function pushBinaryFileToGitHub(
  filePath: string,
  bytes: Buffer,
  commitMessage: string,
): Promise<boolean> {
  try {
    if (!env.GITHUB_TOKEN) return false;

    const encoded = bytes.toString("base64");
    const sha = await getFileSha(filePath);

    const body: Record<string, string> = {
      message: commitMessage,
      content: encoded,
      branch: env.GITHUB_BRANCH,
    };
    if (sha) body.sha = sha;

    const res = await ghFetch(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}`,
      { method: "PUT", body: JSON.stringify(body) },
    );

    return res ? res.ok : false;
  } catch {
    return false;
  }
}

/**
 * Pull raw binary content from GitHub.
 */
export async function pullBinaryFileFromGitHub(
  filePath: string,
): Promise<Buffer | null> {
  try {
    if (!env.GITHUB_TOKEN) return null;

    const res = await ghFetch(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}?ref=${env.GITHUB_BRANCH}`,
    );
    if (!res || !res.ok) return null;

    const data = (await res.json()) as GitHubFileResponse;
    if (!data.content) return null;

    return Buffer.from(data.content, "base64");
  } catch {
    return null;
  }
}

async function pullFileFromGitHub<T>(filePath: string): Promise<T | null> {
  try {
    if (!env.GITHUB_TOKEN) return null;

    const res = await ghFetch(
      `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${filePath}?ref=${env.GITHUB_BRANCH}`,
    );
    if (!res || !res.ok) return null;

    const data = (await res.json()) as GitHubFileResponse;
    if (!data.content) return null;

    const decoded = Buffer.from(data.content, "base64").toString("utf-8");
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}

/**
 * Push all data files in ONE Git commit using the Git Trees API.
 * Called after every correct guess for instant backup.
 * Lightweight debounce: 5s minimum between syncs to prevent GitHub API abuse
 * during rapid-fire correct guesses, while still saving within seconds.
 */
export async function syncToGitHub(force = false): Promise<{ ok: boolean; message: string }> {
  if (!env.GITHUB_TOKEN) {
    return { ok: false, message: "GITHUB_TOKEN not set — skipping sync." };
  }

  // Debounce: minimum 60 seconds between syncs — prevents GitHub API hammering
  // on busy chats where many correct guesses fire in quick succession.
  // Increasing from 5s → 60s dramatically reduces event-loop pressure on Heroku.
  if (!force) {
    try {
      const { redis } = await import("../config/redis");
      const lastSync = await redis.get("github:last_sync");
      if (lastSync && Date.now() - parseInt(lastSync) < 60_000) {
        return { ok: true, message: "Skipped — synced within last 60s." };
      }
      await redis.set("github:last_sync", Date.now().toString(), "EX", 120);
    } catch {}
  }

  try {
    const now = new Date().toISOString();
    const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;

    // ── 1. Fetch all DB tables + get current branch tip in parallel ──────
    const [
      users, leaderboard, bannedUsers, botAdmins, frozenUsers,
      userStats, userChats, games, guesses, authorizedUsers,
      chatGameTopics, broadcastChats, dailyWords, dailyGuesses,
      refRes,
    ] = await Promise.all([
      db.selectFrom("users").selectAll().execute(),
      db.selectFrom("leaderboard").selectAll().execute(),
      db.selectFrom("bannedUsers").selectAll().execute(),
      db.selectFrom("botAdmins").selectAll().execute(),
      db.selectFrom("frozenUsers").selectAll().execute(),
      db.selectFrom("userStats").selectAll().execute(),
      db.selectFrom("userChats").selectAll().execute(),
      db.selectFrom("games").selectAll().execute(),
      db.selectFrom("guesses").selectAll().execute(),
      db.selectFrom("authorizedUsers").selectAll().execute(),
      db.selectFrom("chatGameTopics").selectAll().execute(),
      db.selectFrom("broadcastChats").selectAll().execute(),
      db.selectFrom("dailyWords").selectAll().execute(),
      db.selectFrom("dailyGuesses").selectAll().execute(),
      ghFetch(`${repo}/git/ref/heads/${env.GITHUB_BRANCH}`),
    ]);

    if (!refRes?.ok) throw new Error("Could not fetch branch ref from GitHub");
    const refData = await refRes.json() as { object: { sha: string } };
    const currentCommitSha = refData.object.sha;

    const commitRes = await ghFetch(`${repo}/git/commits/${currentCommitSha}`);
    if (!commitRes?.ok) throw new Error("Could not fetch current commit");
    const commitData = await commitRes.json() as { tree: { sha: string } };
    const baseTreeSha = commitData.tree.sha;

    // ── 2. Build file map ────────────────────────────────────────────────
    const manifest = {
      lastSync: now,
      counts: {
        users: users.length, leaderboard: leaderboard.length,
        bannedUsers: bannedUsers.length, botAdmins: botAdmins.length,
        frozenUsers: frozenUsers.length, userStats: userStats.length,
        userChats: userChats.length, games: games.length,
        guesses: guesses.length, authorizedUsers: authorizedUsers.length,
        chatGameTopics: chatGameTopics.length, broadcastChats: broadcastChats.length,
        dailyWords: dailyWords.length, dailyGuesses: dailyGuesses.length,
      },
    };

    const filesToSync: Array<{ path: string; data: unknown }> = [
      { path: "data/users.json",            data: { timestamp: now, data: users } },
      { path: "data/leaderboard.json",       data: { timestamp: now, data: leaderboard } },
      { path: "data/banned_users.json",      data: { timestamp: now, data: bannedUsers } },
      { path: "data/bot_admins.json",        data: { timestamp: now, data: botAdmins } },
      { path: "data/frozen_users.json",      data: { timestamp: now, data: frozenUsers } },
      { path: "data/user_stats.json",        data: { timestamp: now, data: userStats } },
      { path: "data/user_chats.json",        data: { timestamp: now, data: userChats } },
      { path: "data/games.json",             data: { timestamp: now, data: games } },
      { path: "data/guesses.json",           data: { timestamp: now, data: guesses } },
      { path: "data/authorized_users.json",  data: { timestamp: now, data: authorizedUsers } },
      { path: "data/chat_game_topics.json",  data: { timestamp: now, data: chatGameTopics } },
      { path: "data/broadcast_chats.json",   data: { timestamp: now, data: broadcastChats } },
      { path: "data/daily_words.json",       data: { timestamp: now, data: dailyWords } },
      { path: "data/daily_guesses.json",     data: { timestamp: now, data: dailyGuesses } },
      { path: "data/manifest.json",          data: manifest },
    ];

    // ── 3. Create blobs for all files in parallel ────────────────────────
    const blobResults = await Promise.all(
      filesToSync.map(async ({ path, data }) => {
        const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
        const res = await ghFetch(`${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content, encoding: "base64" }),
        });
        if (!res?.ok) throw new Error(`Blob creation failed for ${path}`);
        const blob = await res.json() as { sha: string };
        return { path, sha: blob.sha };
      }),
    );

    // ── 4. Create new tree ───────────────────────────────────────────────
    const treeRes = await ghFetch(`${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: blobResults.map(({ path, sha }) => ({
          path, sha, mode: "100644", type: "blob",
        })),
      }),
    });
    if (!treeRes?.ok) throw new Error("Tree creation failed");
    const treeData = await treeRes.json() as { sha: string };

    // ── 5. Create commit ─────────────────────────────────────────────────
    const newCommitRes = await ghFetch(`${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `sync: ${users.length} users, ${games.length} games [${now}]`,
        tree: treeData.sha,
        parents: [currentCommitSha],
      }),
    });
    if (!newCommitRes?.ok) throw new Error("Commit creation failed");
    const newCommit = await newCommitRes.json() as { sha: string };

    // ── 6. Update branch ref ─────────────────────────────────────────────
    const updateRes = await ghFetch(`${repo}/git/refs/heads/${env.GITHUB_BRANCH}`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommit.sha }),
    });
    if (!updateRes?.ok) throw new Error("Branch ref update failed");

    return {
      ok: true,
      message: `✅ Synced to GitHub: ${users.length} users, ${leaderboard.length} scores, ${games.length} games, ${guesses.length} guesses`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `❌ Sync failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function restoreFromGitHub(): Promise<{ ok: boolean; message: string }> {
  if (!env.GITHUB_TOKEN) {
    return { ok: false, message: "GITHUB_TOKEN not set — skipping restore." };
  }

  try {
    // Check leaderboard — NOT users table.
    // userAndChatSyncHandler adds users within seconds of startup, causing
    // a false "already has data" skip before restore even runs.
    // Leaderboard rows are only added by actual gameplay, so it's the safe check.
    const existingScore = await db
      .selectFrom("leaderboard")
      .select("id")
      .limit(1)
      .executeTakeFirst();

    if (existingScore) {
      return { ok: true, message: "DB already has data — skipping restore." };
    }

    const manifest = await pullFileFromGitHub<{ counts: Record<string, number> }>("data/manifest.json");
    if (!manifest) {
      return { ok: false, message: "No GitHub backup found or token invalid." };
    }

    const [
      usersFile, lbFile, banFile, adminFile, frozenFile,
      statsFile, userChatsFile, gamesFile, guessesFile,
      authorizedFile, chatTopicsFile, broadcastFile,
      dailyWordsFile, dailyGuessesFile,
    ] = await Promise.all([
      pullFileFromGitHub<{ data: any[] }>("data/users.json"),
      pullFileFromGitHub<{ data: any[] }>("data/leaderboard.json"),
      pullFileFromGitHub<{ data: any[] }>("data/banned_users.json"),
      pullFileFromGitHub<{ data: any[] }>("data/bot_admins.json"),
      pullFileFromGitHub<{ data: any[] }>("data/frozen_users.json"),
      pullFileFromGitHub<{ data: any[] }>("data/user_stats.json"),
      pullFileFromGitHub<{ data: any[] }>("data/user_chats.json"),
      pullFileFromGitHub<{ data: any[] }>("data/games.json"),
      pullFileFromGitHub<{ data: any[] }>("data/guesses.json"),
      pullFileFromGitHub<{ data: any[] }>("data/authorized_users.json"),
      pullFileFromGitHub<{ data: any[] }>("data/chat_game_topics.json"),
      pullFileFromGitHub<{ data: any[] }>("data/broadcast_chats.json"),
      pullFileFromGitHub<{ data: any[] }>("data/daily_words.json"),
      pullFileFromGitHub<{ data: any[] }>("data/daily_guesses.json"),
    ]);

    // ── Batch insert helper: chunks into groups for fast bulk upsert ─────────
    async function batchInsert<T extends object>(
      rows: T[],
      insertFn: (chunk: T[]) => Promise<void>,
      chunkSize = 500,
    ) {
      for (let i = 0; i < rows.length; i += chunkSize) {
        await insertFn(rows.slice(i, i + chunkSize)).catch(() => {});
      }
    }

    // High-row tables — parallelised bulk insert (users, leaderboard, broadcastChats, userChats)
    await Promise.all([
      usersFile?.data?.length
        ? batchInsert(usersFile.data, (chunk) =>
            db.insertInto("users").values(chunk)
              .onConflict((oc) => oc.column("id").doUpdateSet({
                name: (eb) => eb.ref("excluded.name"),
                username: (eb) => eb.ref("excluded.username"),
              }))
              .execute().then(() => {}))
        : Promise.resolve(),

      lbFile?.data?.length
        ? batchInsert(lbFile.data, (chunk) =>
            db.insertInto("leaderboard").values(chunk)
              .onConflict((oc) => oc.column("id").doNothing())
              .execute().then(() => {}))
        : Promise.resolve(),

      broadcastFile?.data?.length
        ? batchInsert(broadcastFile.data, (chunk) =>
            db.insertInto("broadcastChats").values(chunk)
              .onConflict((oc) => oc.column("id").doUpdateSet({
                name: (eb) => eb.ref("excluded.name"),
                username: (eb) => eb.ref("excluded.username"),
              }))
              .execute().then(() => {}))
        : Promise.resolve(),

      userChatsFile?.data?.length
        ? batchInsert(userChatsFile.data, (chunk) =>
            db.insertInto("userChats").values(chunk)
              .onConflict((oc) => oc.columns(["userId", "chatId"]).doNothing())
              .execute().then(() => {}))
        : Promise.resolve(),
    ]);

    // Smaller tables — batched but sequential (low row counts)
    if (gamesFile?.data?.length) {
      await batchInsert(gamesFile.data, (chunk) =>
        db.insertInto("games").values(chunk)
          .onConflict((oc) => oc.column("id").doNothing())
          .execute().then(() => {}));
    }
    if (guessesFile?.data?.length) {
      await batchInsert(guessesFile.data, (chunk) =>
        db.insertInto("guesses").values(chunk)
          .onConflict((oc) => oc.column("id").doNothing())
          .execute().then(() => {}));
    }
    if (dailyWordsFile?.data?.length) {
      await batchInsert(dailyWordsFile.data, (chunk) =>
        db.insertInto("dailyWords").values(chunk)
          .onConflict((oc) => oc.column("id").doNothing())
          .execute().then(() => {}));
    }
    if (dailyGuessesFile?.data?.length) {
      await batchInsert(dailyGuessesFile.data, (chunk) =>
        db.insertInto("dailyGuesses").values(chunk)
          .onConflict((oc) => oc.column("id").doNothing())
          .execute().then(() => {}));
    }
    if (authorizedFile?.data?.length) {
      await batchInsert(authorizedFile.data, (chunk) =>
        db.insertInto("authorizedUsers").values(chunk)
          .onConflict((oc) => oc.columns(["chatId", "userId"]).doNothing())
          .execute().then(() => {}));
    }
    if (chatTopicsFile?.data?.length) {
      await batchInsert(chatTopicsFile.data, (chunk) =>
        db.insertInto("chatGameTopics").values(chunk)
          .onConflict((oc) => oc.columns(["chatId", "topicId"]).doNothing())
          .execute().then(() => {}));
    }
    if (banFile?.data?.length) {
      await batchInsert(banFile.data, (chunk) =>
        db.insertInto("bannedUsers").values(chunk)
          .onConflict((oc) => oc.column("userId").doNothing())
          .execute().then(() => {}));
    }
    if (adminFile?.data?.length) {
      await batchInsert(adminFile.data, (chunk) =>
        db.insertInto("botAdmins").values(chunk)
          .onConflict((oc) => oc.column("userId").doNothing())
          .execute().then(() => {}));
    }
    if (frozenFile?.data?.length) {
      await batchInsert(frozenFile.data, (chunk) =>
        db.insertInto("frozenUsers").values(chunk)
          .onConflict((oc) => oc.column("userId").doNothing())
          .execute().then(() => {}));
    }
    if (statsFile?.data?.length) {
      await batchInsert(statsFile.data, (chunk) =>
        db.insertInto("userStats").values(chunk)
          .onConflict((oc) => oc.column("userId").doNothing())
          .execute().then(() => {}));
    }

    return {
      ok: true,
      message: `✅ Restored from GitHub (${manifest.counts?.users ?? "?"} users, ${manifest.counts?.leaderboard ?? "?"} scores)`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `❌ Restore failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Fix 6: Sync every 5 hours (not every hour) to reduce Heroku restart loops.
 * Instant saves happen via syncToGitHub() calls after score events.
 */
export const githubSyncCron = new CronJob(
  "0 0 */5 * * *", // Every 5 hours
  async () => {
    if (!env.GITHUB_TOKEN) return;
    await syncToGitHub(true).catch(() => {});
  },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);

// ── Owner DM Backup — every 24 hours ─────────────────────────────────────────
// Sends a complete JSON backup of ALL database tables to the owner's Telegram
// DM every 24 hours. No data is cut or skipped — the file includes every table.
// Owner ID comes from ADMIN_USERS[0].

export async function sendOwnerBackup(): Promise<void> {
  if (!env.ADMIN_USERS || env.ADMIN_USERS.length === 0) return;

  try {
    const now = new Date().toISOString();
    const { bot } = await import("../config/bot");

    // Fetch all tables in parallel
    const [
      users, leaderboard, bannedUsers, botAdmins, frozenUsers,
      userStats, userChats, games, guesses, authorizedUsers,
      chatGameTopics, broadcastChats, dailyWords, dailyGuesses,
    ] = await Promise.all([
      db.selectFrom("users").selectAll().execute(),
      db.selectFrom("leaderboard").selectAll().execute(),
      db.selectFrom("bannedUsers").selectAll().execute(),
      db.selectFrom("botAdmins").selectAll().execute(),
      db.selectFrom("frozenUsers").selectAll().execute(),
      db.selectFrom("userStats").selectAll().execute(),
      db.selectFrom("userChats").selectAll().execute(),
      db.selectFrom("games").selectAll().execute(),
      db.selectFrom("guesses").selectAll().execute(),
      db.selectFrom("authorizedUsers").selectAll().execute(),
      db.selectFrom("chatGameTopics").selectAll().execute(),
      db.selectFrom("broadcastChats").selectAll().execute(),
      db.selectFrom("dailyWords").selectAll().execute(),
      db.selectFrom("dailyGuesses").selectAll().execute(),
    ]);

    const fullBackup = {
      backupTime: now,
      summary: {
        users: users.length,
        leaderboard: leaderboard.length,
        bannedUsers: bannedUsers.length,
        botAdmins: botAdmins.length,
        frozenUsers: frozenUsers.length,
        userStats: userStats.length,
        userChats: userChats.length,
        games: games.length,
        guesses: guesses.length,
        authorizedUsers: authorizedUsers.length,
        chatGameTopics: chatGameTopics.length,
        broadcastChats: broadcastChats.length,
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
        userChats,
        games,
        guesses,
        authorizedUsers,
        chatGameTopics,
        broadcastChats,
        dailyWords,
        dailyGuesses,
      },
    };

    const jsonBuffer = Buffer.from(JSON.stringify(fullBackup, null, 2), "utf-8");
    const fileName = `wordseek_backup_${now.replace(/[:.]/g, "-").substring(0, 19)}.json`;

    // Send to every owner in ADMIN_USERS
    for (const ownerId of env.ADMIN_USERS) {
      try {
        await bot.api.sendDocument(
          ownerId,
          new (await import("grammy")).InputFile(jsonBuffer, fileName),
          {
            caption:
              `🗄️ <b>WordSeek Full Database Backup</b>\n\n` +
              `<blockquote>📅 Time: <code>${now}</code>\n\n` +
              `📊 <b>Summary:</b>\n` +
              `• Users: <code>${users.length}</code>\n` +
              `• Leaderboard entries: <code>${leaderboard.length}</code>\n` +
              `• Banned users: <code>${bannedUsers.length}</code>\n` +
              `• Bot admins: <code>${botAdmins.length}</code>\n` +
              `• Active games: <code>${games.length}</code>\n` +
              `• Total guesses: <code>${guesses.length}</code>\n` +
              `• Daily words: <code>${dailyWords.length}</code>\n` +
              `• Broadcast chats: <code>${broadcastChats.length}</code></blockquote>\n\n` +
              `All tables included — no data skipped.`,
            parse_mode: "HTML",
          },
        );
      } catch (err) {
        console.error(`Failed to send backup to owner ${ownerId}:`, err);
      }
    }
  } catch (err) {
    console.error("Owner backup failed:", err);
  }
}

/**
 * Owner DM backup cron — runs every 24 hours at midnight IST.
 * Sends full JSON backup of all DB tables to the owner's Telegram DM.
 */
export const ownerBackupCron = new CronJob(
  "0 0 0 * * *", // Every day at midnight
  async () => {
    await sendOwnerBackup().catch((err) => console.error("ownerBackupCron error:", err));
  },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);
