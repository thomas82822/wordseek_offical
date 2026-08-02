/**
 * Bot Mode Commands
 *
 * /botmode on|off              — Toggle bot mode (owner only)
 * /autobotmode on|off          — Toggle auto-schedule (owner only)
 * /startcompetition [hours]    — Start a competition between 2–3 bots
 * /stopcompetition             — Stop current competition
 * /scanname                    — Scan real user names from DB, assign to bots
 * /botlist                     — List all bot users
 * /botsetlimit <id|all> <pts>  — Set daily limit
 * /botsetspeed <id|all> <secs> — Set play speed
 * /botreset <id|all>           — Reset daily counters
 * /botname <id> <name>         — Rename a bot
 *
 * Bot Score Behaviour (when bot mode is ON):
 * - Scores grow gradually and human-like: small steps (1–4 pts) per correct guess
 * - Total daily score is capped at dailyLimit (default 50,000 pts max)
 * - Each bot has a random daily limit between 8,000 and 55,000 pts
 *   so scores vary naturally across the leaderboard
 * - Bot scores are written with chatId = "bot_mode" so they are EXCLUDED
 *   from "This Chat" leaderboard views (only appear in Global leaderboard)
 */

import { Composer } from "grammy";

import { env } from "../config/env";
import { redis } from "../config/redis";
import { CommandsHelper } from "../util/commands-helper";
import {
  getBotUsers,
  getCompetition,
  initBotUsers,
  isAutoModeEnabled,
  isAutobotEnabled,
  isBotModeEnabled,
  modifyName,
  saveBotUsers,
  scanNamesFromDB,
  setAutobot,
  setAutoMode,
  setBotMode,
  startCompetition,
  stopCompetition,
  type BotUser,
} from "../services/bot-mode";

const composer = new Composer();

function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function isOwner(userId: number): boolean {
  return env.ADMIN_USERS.includes(userId);
}

// ── /botmode on|off ────────────────────────────────────────────────────────────
composer.command("botmode", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  await initBotUsers();

  const arg = ctx.match.trim().toLowerCase();
  if (arg !== "on" && arg !== "off") {
    const [enabled, competition] = await Promise.all([isBotModeEnabled(), getCompetition()]);
    return ctx.reply(
      `🤖 <b>Bot Mode</b>\n\nStatus: ${enabled ? "🟢 <b>ON</b>" : "🔴 <b>OFF</b>"}\n` +
        (competition ? `🏆 Competition active — ends <i>${new Date(competition.endsAt).toLocaleString()}</i>\n` : "") +
        `\nUsage: /botmode on | off`,
      { parse_mode: "HTML" },
    );
  }

  await setBotMode(arg === "on");

  if (arg === "on") {
    const users = await getBotUsers();
    const enabledCount = users.filter((u) => u.enabled).length;
    await ctx.reply(
      `🤖 <b>Bot Mode ENABLED</b>\n\n` +
        `<blockquote>✅ ${enabledCount} bots activated — waking up gradually over the next 25 minutes.\n\n` +
        `📊 Scores grow human-like (small increments), max ~50k each.\n` +
        `📋 Bot scores appear in Global leaderboard only (not "This Chat").\n\n` +
        `Use /startcompetition to make 2–3 bots race each other.\n` +
        `Use /autobotmode on for daily auto-scheduling.\n` +
        `Use /scanname to grab real user names for bots.</blockquote>`,
      { parse_mode: "HTML" },
    );
  } else {
    await stopCompetition();
    await ctx.reply(`🤖 <b>Bot Mode DISABLED</b>\n\nAll bots stopped. Competition cleared.`, { parse_mode: "HTML" });
  }
});

// ── /autobotmode on|off ────────────────────────────────────────────────────────
composer.command("autobotmode", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;

  const arg = ctx.match.trim().toLowerCase();
  if (arg !== "on" && arg !== "off") {
    const on = await isAutoModeEnabled();
    return ctx.reply(
      `⏰ <b>Auto Bot Mode</b>\n\nStatus: ${on ? "🟢 <b>ON</b>" : "🔴 <b>OFF</b>"}\n\n` +
        `When enabled, bots auto-start each day at a random time between 8am–12pm IST and run for 8–14 hours.\n` +
        `A competition is randomly triggered ~40% of days.\n\nUsage: /autobotmode on | off`,
      { parse_mode: "HTML" },
    );
  }

  await setAutoMode(arg === "on");
  await ctx.reply(
    arg === "on"
      ? `⏰ <b>Auto Bot Mode ENABLED</b>\n\nBots will auto-start daily at a random morning time and stop automatically.`
      : `⏰ <b>Auto Bot Mode DISABLED</b>\n\nNo more automatic daily scheduling.`,
    { parse_mode: "HTML" },
  );
});

// ── /startcompetition [hours] ─────────────────────────────────────────────────
composer.command("startcompetition", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  await initBotUsers();

  const hoursArg = parseInt(ctx.match.trim());
  const durationHours = isNaN(hoursArg) || hoursArg < 1 ? 2 : Math.min(hoursArg, 24);

  const competition = await startCompetition(durationHours);
  if (!competition) {
    return ctx.reply(`❌ Could not start competition. Bot mode must be ON and at least 2 bots enabled.`);
  }

  const users = await getBotUsers();
  const competitors = users.filter((u) => competition.botIds.includes(u.id));
  const names = competitors.map((u) => escHtml(u.name)).join(", ");

  await ctx.reply(
    `🏆 <b>Competition Started!</b>\n\n` +
      `<blockquote>🤖 Competitors: ${names}\n` +
      `⏱️ Duration: ${durationHours} hour(s)\n` +
      `🏁 Ends: <i>${new Date(competition.endsAt).toLocaleString()}</i>\n\n` +
      `Watch /leaderboard to see them climb!</blockquote>`,
    { parse_mode: "HTML" },
  );
});

// ── /stopcompetition ──────────────────────────────────────────────────────────
composer.command("stopcompetition", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  await stopCompetition();
  return ctx.reply(`🏁 Competition stopped.`);
});

// ── /scanname ─────────────────────────────────────────────────────────────────
composer.command("scanname", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  await initBotUsers();
  const count = await scanNamesFromDB();
  return ctx.reply(`✅ Scanned and assigned ${count} real user names to bots.`);
});

// ── /botlist ──────────────────────────────────────────────────────────────────
composer.command("botlist", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  await initBotUsers();
  const users = await getBotUsers();
  const competition = await getCompetition();

  if (users.length === 0) return ctx.reply(`No bots configured yet.`);

  const today = new Date().toISOString().split("T")[0];
  const scores = await Promise.all(
    users.map(async (u) => {
      const val = await redis.get(`botmode:daily:${u.id}:${today}`);
      return { id: u.id, score: val ? parseInt(val) : 0 };
    }),
  );
  const scoreMap = new Map(scores.map((s) => [s.id, s.score]));

  let msg = `🤖 <b>Bot Players (${users.length})</b>\n\n`;
  for (const u of users) {
    const daily = scoreMap.get(u.id) ?? 0;
    const pct = Math.round((daily / u.dailyLimit) * 100);
    const inComp = competition?.botIds.includes(u.id) ? " 🏆" : "";
    msg += `${u.enabled ? "🟢" : "🔴"} <b>${escHtml(u.name)}</b>${inComp}\n`;
    msg += `   ID: <code>${u.id}</code> (#${u.numId})\n`;
    msg += `   Daily: <code>${daily.toLocaleString()}/${u.dailyLimit.toLocaleString()}</code> | Speed: ${Math.round(u.speedMs / 1000)}s\n\n`;
  }
  return ctx.reply(msg, { parse_mode: "HTML" });
});

// ── /botsetlimit <id|all> <pts> ───────────────────────────────────────────────
composer.command("botsetlimit", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Usage: <code>/botsetlimit &lt;id|all&gt; &lt;pts&gt;</code>", { parse_mode: "HTML" });
  const [target, limitStr] = parts;
  const limit = parseInt(limitStr);
  if (isNaN(limit) || limit < 100) return ctx.reply(`❌ Limit must be at least 100.`);
  await initBotUsers();
  const users = await getBotUsers();
  if (target === "all") {
    users.forEach((u) => (u.dailyLimit = limit));
    await saveBotUsers(users);
    return ctx.reply(`✅ All bots daily limit set to <code>${limit.toLocaleString()}</code>.`, { parse_mode: "HTML" });
  }
  const b = users.find((u) => u.id === target || u.numId.toString() === target);
  if (!b) return ctx.reply(`❌ Bot not found.`);
  b.dailyLimit = limit;
  await saveBotUsers(users);
  return ctx.reply(`✅ <b>${escHtml(b.name)}</b> daily limit set to <code>${limit.toLocaleString()}</code>.`, { parse_mode: "HTML" });
});

// ── /botsetspeed <id|all> <secs> ──────────────────────────────────────────────
composer.command("botsetspeed", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Usage: <code>/botsetspeed &lt;id|all&gt; &lt;secs&gt;</code>", { parse_mode: "HTML" });
  const [target, secsStr] = parts;
  const secs = parseInt(secsStr);
  if (isNaN(secs) || secs < 1) return ctx.reply(`❌ Speed must be at least 1 second.`);
  await initBotUsers();
  const users = await getBotUsers();
  if (target === "all") {
    users.forEach((u) => (u.speedMs = secs * 1000));
    await saveBotUsers(users);
    return ctx.reply(`✅ All bots speed set to every <code>${secs}</code>s.`, { parse_mode: "HTML" });
  }
  const b = users.find((u) => u.id === target || u.numId.toString() === target);
  if (!b) return ctx.reply(`❌ Bot not found.`);
  b.speedMs = secs * 1000;
  await saveBotUsers(users);
  return ctx.reply(`✅ <b>${escHtml(b.name)}</b> speed set to every <code>${secs}</code>s.`, { parse_mode: "HTML" });
});

// ── /botreset <id|all> ────────────────────────────────────────────────────────
composer.command("botreset", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  const target = ctx.match.trim();
  await initBotUsers();
  const users = await getBotUsers();
  const today = new Date().toISOString().split("T")[0];
  if (target === "all") {
    await Promise.all(users.map((u) => redis.del(`botmode:daily:${u.id}:${today}`)));
    return ctx.reply("✅ All bot daily scores reset.");
  }
  const b = users.find((u) => u.id === target || u.numId.toString() === target);
  if (!b) return ctx.reply(`❌ Bot not found.`);
  await redis.del(`botmode:daily:${b.id}:${today}`);
  return ctx.reply(`✅ <b>${escHtml(b.name)}</b> daily score reset.`, { parse_mode: "HTML" });
});

// ── /botname <id> <name> ──────────────────────────────────────────────────────
composer.command("botname", async (ctx) => {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  const parts = ctx.match.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Usage: <code>/botname &lt;bot_id&gt; &lt;new name&gt;</code>", { parse_mode: "HTML" });
  const [target, ...nameParts] = parts;
  const newName = nameParts.join(" ");
  await initBotUsers();
  const users = await getBotUsers();
  const b = users.find((u) => u.id === target || u.numId.toString() === target);
  if (!b) return ctx.reply("❌ Bot not found.");
  await modifyName(b.id, newName);
  return ctx.reply(`✅ Bot <code>${b.id}</code> renamed to <b>${escHtml(newName)}</b>.`, { parse_mode: "HTML" });
});

CommandsHelper.addNewCommand("botmode", "Toggle bot mode (owner only)", true);
CommandsHelper.addNewCommand("autobotmode", "Auto-schedule bot mode daily (owner only)", true);
CommandsHelper.addNewCommand("startcompetition", "Start bot competition (owner only)", true);
CommandsHelper.addNewCommand("scanname", "Scan real user names for bots (owner only)", true);
CommandsHelper.addNewCommand("botlist", "List all bot players (owner only)", true);

export const botModeCommand = composer;
