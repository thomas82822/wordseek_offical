/**
 * Bot Mode Service — Human-like virtual player simulation
 *
 * Features:
 * - 60 virtual bots that inject scores silently into the leaderboard
 * - Gradual wake-up stagger when bot mode is enabled (looks natural)
 * - Competition mode: 2–3 bots race each other at 3–4× normal speed
 * - Auto-schedule: bot mode auto-turns on/off on a daily schedule
 * - Names sourced from real group users (slightly modified)
 * - Each bot has a unique personality (slow/medium/fast/burst)
 * - NO win messages sent to groups — purely leaderboard-level
 */

import { CronJob } from "cron";

import { bot } from "../config/bot";
import { db } from "../config/db";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { memCache } from "../config/cache";
import allSixWords from "../data/all-six.json";
import allFiveWords from "../data/all-five.json";
import allFourWords from "../data/all-four.json";

// ── Types ──────────────────────────────────────────────────────────────────────
export interface BotUser {
  id: string;
  numId: number;
  name: string;
  modes: ("4" | "5" | "6")[];
  dailyLimit: number;
  speedMs: number;
  enabled: boolean;
  personality: "slow" | "medium" | "fast" | "burst"; // hidden profile
}

interface CompetitionState {
  botIds: string[];
  startedAt: number;
  endsAt: number;
  speedMs: number; // boosted speed during competition
}

// ── Redis keys ─────────────────────────────────────────────────────────────────
const BOT_MODE_KEY     = "botmode:enabled";
const BOT_USERS_KEY    = "botmode:users";
const BOT_NAMES_KEY    = "botmode:names";
const BOT_KNOWN_CHATS  = "botmode:known_chats";
const COMPETITION_KEY  = "botmode:competition";
const AUTO_MODE_KEY    = "botmode:auto:enabled";
const AUTO_SCHEDULE_KEY= "botmode:auto:schedule";
const AUTOBOT_KEY        = "autobot:enabled";
const AUTOBOT_WAKE_KEY   = "autobot:next_wake";

const ALL_WORDS: Record<string, string[]> = {
  "4": allFourWords,
  "5": allFiveWords,
  "6": allSixWords,
};

// ── Speed profiles per personality ────────────────────────────────────────────
// 10 min = 1000 pts target → 60 bots × avg 1.5 wins/10min × avg 11 pts = ~990/10min
const SPEED_PROFILE: Record<BotUser["personality"], [number, number]> = {
  // Tuned so burst bots score 80–140 pts/min → top 3 hit 30k+ per day.
  burst:  [   45_000,   90_000],  // 45 s–90 s  → ~80–140 pts/min
  fast:   [   90_000,  4*60_000],  // 1.5–4 min
  medium: [ 4*60_000, 10*60_000],  // 4–10 min
  slow:   [10*60_000, 18*60_000],  // 10–18 min
};

// Default 60 Indian-style names with more variety
const DEFAULT_NAMES = [
  "Aarav K", "Vivaan S", "Aditya M", "Vihaan P", "Arjun R",
  "Sai N", "Reyansh D", "Ayaan T", "Krishna V", "Ishaan B",
  "Shaurya G", "Atharv C", "Dhruv J", "Kabir L", "Ritvik A",
  "Aarush H", "Darsh F", "Veer W", "Krish E", "Arnav Q",
  "Priya I", "Ananya O", "Diya U", "Kavya Y", "Meera Z",
  "Naina X", "Pooja W", "Riya V", "Sneha U", "Tara T",
  "Anika S", "Bhavna R", "Charu Q", "Deepa P", "Esha O",
  "Fatima N", "Gauri M", "Hina L", "Isha K", "Jiya J",
  "Rohan P", "Rahul M", "Raj S", "Ravi K", "Ramesh T",
  "Rakesh V", "Ramit B", "Rashid C", "Ratan D", "Raunak E",
  "Dev F", "Deepak G", "Dinesh H", "Divya I", "Dhruva J",
  "Pankaj K", "Paras L", "Parth M", "Pavan N", "Piyush O",
];

// ── Name mutation — creates human-looking variants ─────────────────────────────
export function modifyName(name: string): string {
  const parts = name.trim().split(/\s+/);
  const strategies = [
    // First name + initial
    () => parts.length >= 2 ? `${parts[0]} ${parts[1][0]}.` : name,
    // First name only (shortened)
    () => parts[0].length > 4 ? parts[0].slice(0, -1) : parts[0],
    // Swapped order (last first)
    () => parts.length >= 2 ? `${parts[parts.length - 1]} ${parts[0][0]}` : name,
    // Nickname suffix
    () => parts[0] + ["_xd", "._.", " Jr", "07", "99"][Math.floor(Math.random() * 5)],
    // Just a bit scrambled first name
    () => {
      const n = parts[0];
      if (n.length < 4) return n;
      return n[0].toUpperCase() + n.slice(1, -1).toLowerCase() + n[n.length - 1];
    },
  ];
  const fn = strategies[Math.floor(Math.random() * strategies.length)];
  return fn();
}

// ── Init / CRUD ────────────────────────────────────────────────────────────────
export async function initBotUsers(): Promise<void> {
  const existing = await redis.get(BOT_USERS_KEY);
  if (existing) {
    // Migration: add personality field + fix speeds
    const users: BotUser[] = JSON.parse(existing);
    let changed = false;
    const personalities: BotUser["personality"][] = ["slow", "medium", "fast", "burst"];
    for (const u of users) {
      if (!u.personality) {
        // 50% medium, 25% slow, 15% fast, 10% burst
        const roll = Math.random();
        u.personality = roll < 0.1 ? "burst" : roll < 0.25 ? "fast" : roll < 0.5 ? "slow" : "medium";
        changed = true;
      }
      // Fix stale speeds that are out of profile range
      const [min, max] = SPEED_PROFILE[u.personality];
      if (u.speedMs < 60_000 || u.speedMs > max * 1.5) {
        u.speedMs = min + Math.floor(Math.random() * (max - min));
        changed = true;
      }
    }
    // Upgrade stale daily limits that are too low for 30k+/day target
    for (const u of users) {
      const minLimit =
        u.personality === "burst"  ? 38000 :
        u.personality === "fast"   ? 20000 :
        u.personality === "medium" ? 10000 : 5000;
      if (u.dailyLimit < minLimit) {
        const maxExtra =
          u.personality === "burst"  ? 12001 :
          u.personality === "fast"   ? 15001 :
          u.personality === "medium" ? 10001 : 7001;
        u.dailyLimit = minLimit + Math.floor(Math.random() * maxExtra);
        changed = true;
      }
    }
    if (changed) await redis.set(BOT_USERS_KEY, JSON.stringify(users));
    return;
  }

  // 15 burst + 15 fast + 20 medium + 10 slow = 60 bots
  // Shuffled so they're scattered across leaderboard positions naturally.
  const rawDist: BotUser["personality"][] = [
    ...Array(15).fill("burst") as BotUser["personality"][],
    ...Array(15).fill("fast")  as BotUser["personality"][],
    ...Array(20).fill("medium") as BotUser["personality"][],
    ...Array(10).fill("slow")  as BotUser["personality"][],
  ];
  // Fisher-Yates shuffle for natural distribution
  for (let i = rawDist.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rawDist[i], rawDist[j]] = [rawDist[j], rawDist[i]];
  }
  const users: BotUser[] = Array.from({ length: 60 }, (_, i) => {
    const idx = i + 1;
    const modes: ("4"|"5"|"6")[] = i % 3 === 0 ? ["4","5","6"] : i % 3 === 1 ? ["5","6"] : ["4","5"];
    const personality = rawDist[i];
    const [min, max] = SPEED_PROFILE[personality];
    // Daily limit by personality — top bots need 30k+ headroom
    const dailyLimit =
      personality === "burst"  ? 38000 + Math.floor(Math.random() * 12001) : // 38k–50k
      personality === "fast"   ? 20000 + Math.floor(Math.random() * 15001) : // 20k–35k
      personality === "medium" ? 10000 + Math.floor(Math.random() * 10001) : // 10k–20k
                                  5000 + Math.floor(Math.random() * 7001);   //  5k–12k
    return {
      id: `bot_${String(idx).padStart(3, "0")}`,
      numId: 9900000000 + idx,
      name: DEFAULT_NAMES[i] ?? `Player${idx}`,
      modes,
      dailyLimit,
      speedMs: min + Math.floor(Math.random() * (max - min)),
      enabled: true,
      personality,
    };
  });

  await redis.set(BOT_USERS_KEY, JSON.stringify(users));
}

export async function getBotUsers(): Promise<BotUser[]> {
  const raw = await redis.get(BOT_USERS_KEY);
  return raw ? JSON.parse(raw) : [];
}

export async function saveBotUsers(users: BotUser[]): Promise<void> {
  await redis.set(BOT_USERS_KEY, JSON.stringify(users));
}

export async function isBotModeEnabled(): Promise<boolean> {
  const val = await redis.get(BOT_MODE_KEY);
  return val === "1";
}

export async function setBotMode(enabled: boolean): Promise<void> {
  if (enabled) {
    await redis.set(BOT_MODE_KEY, "1");
    await _staggerBotWakeups();
  } else {
    await redis.del(BOT_MODE_KEY);
  }
}

// ── Stagger wake-up when bot mode is enabled ───────────────────────────────────
// Bots don't all start at once — they wake up over the first 25 minutes.
// This makes the leaderboard activity look natural and gradual.
async function _staggerBotWakeups(): Promise<void> {
  const users = await getBotUsers();
  await Promise.all(users.map((u) => {
    const delayMs = Math.floor(Math.random() * 25 * 60_000); // 0–25 min spread
    const wakeAt = (Date.now() + delayMs).toString();
    return redis.set(`botmode:wake:${u.id}`, wakeAt, "EX", 1800).catch(() => {});
  }));
}

async function isBotAwake(botId: string): Promise<boolean> {
  const wakeAt = await redis.get(`botmode:wake:${botId}`);
  if (!wakeAt) return true;
  return Date.now() >= parseInt(wakeAt);
}

// ── Register known chats ───────────────────────────────────────────────────────
// memCache guard: skip Redis SADD+EXPIRE if we already registered this chat
// in the last 10 minutes.  Redis SADD is idempotent so the skip is safe.
export async function registerBotChat(chatId: string): Promise<void> {
  if (!chatId || chatId === "admin") return;
  const memKey = `kc:${chatId}`;
  if (memCache.get<boolean>(memKey)) return;
  memCache.set(memKey, true, 10 * 60_000); // 10 min
  await redis.sadd(BOT_KNOWN_CHATS, chatId);
  await redis.expire(BOT_KNOWN_CHATS, 30 * 24 * 60 * 60);
}

// ── Daily score tracking ───────────────────────────────────────────────────────
async function getBotDailyScore(botId: string): Promise<number> {
  const today = new Date().toISOString().split("T")[0];
  const val = await redis.get(`botmode:daily:${botId}:${today}`);
  return val ? parseInt(val) : 0;
}

async function addBotDailyScore(botId: string, score: number): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const key = `botmode:daily:${botId}:${today}`;
  const cur = await redis.get(key);
  const next = (cur ? parseInt(cur) : 0) + score;
  await redis.set(key, next.toString(), "EX", 30 * 3600);
}

// ── Last-play tracking ─────────────────────────────────────────────────────────
async function isBotReadyToPlay(botId: string, speedMs: number): Promise<boolean> {
  const key = `botmode:last:${botId}`;
  const last = await redis.get(key);
  if (!last) return true;
  return Date.now() - parseInt(last) >= speedMs;
}

async function markBotPlayed(botId: string): Promise<void> {
  await redis.set(`botmode:last:${botId}`, Date.now().toString(), "EX", 86400);
}

// ── Name collection ────────────────────────────────────────────────────────────
export async function addNameFromGroup(name: string): Promise<void> {
  try {
    const raw = await redis.get(BOT_NAMES_KEY);
    const names: string[] = raw ? JSON.parse(raw) : [];
    if (!names.includes(name) && name.length > 1) {
      names.push(name);
      if (names.length > 600) names.shift();
      await redis.set(BOT_NAMES_KEY, JSON.stringify(names));
      await _updateBotNamesFromPool(names);
    }
  } catch {}
}

/** Scan real user names from the DB and assign modified versions to bots */
export async function scanNamesFromDB(): Promise<number> {
  try {
    const users = await db
      .selectFrom("users")
      .select(["users.name"])
      .where("users.id", "not like", "990000000%") // exclude fake bots
      .where("users.name", "is not", null)
      .limit(300)
      .execute();

    let added = 0;
    for (const u of users) {
      if (u.name && u.name.trim().length > 1) {
        const raw = await redis.get(BOT_NAMES_KEY);
        const names: string[] = raw ? JSON.parse(raw) : [];
        const modified = modifyName(u.name);
        if (!names.includes(modified)) {
          names.push(modified);
          if (names.length > 600) names.shift();
          await redis.set(BOT_NAMES_KEY, JSON.stringify(names));
          added++;
        }
      }
    }

    // Re-assign bot names from updated pool
    const allNames: string[] = JSON.parse((await redis.get(BOT_NAMES_KEY)) || "[]");
    await _updateBotNamesFromPool(allNames);
    return added;
  } catch {
    return 0;
  }
}

async function _updateBotNamesFromPool(names: string[]): Promise<void> {
  const users = await getBotUsers();
  let changed = false;
  // Assign names to bots, ensuring no two bots share the same name
  const used = new Set<string>();
  for (let i = 0; i < users.length; i++) {
    const candidate = names[i];
    if (candidate && !used.has(candidate)) {
      users[i].name = candidate;
      used.add(candidate);
      changed = true;
    }
  }
  if (changed) await saveBotUsers(users);
}

// ── Get known chats ────────────────────────────────────────────────────────────
async function _getKnownChats(): Promise<string[]> {
  const cached = await redis.smembers(BOT_KNOWN_CHATS);
  if (cached.length > 0) return cached.filter((c) => c && c !== "admin");

  // Fallback: seed from active games
  const activeGames = await db.selectFrom("games").select("activeChat").execute();
  const fromGames = [...new Set(activeGames.map((g) => g.activeChat))].filter(
    (c) => c && c !== "admin",
  );
  if (fromGames.length > 0) {
    await redis.sadd(BOT_KNOWN_CHATS, ...fromGames);
    await redis.expire(BOT_KNOWN_CHATS, 30 * 24 * 60 * 60);
  }
  return fromGames;
}

// ── Competition Mode ───────────────────────────────────────────────────────────

/** Start a competition between 2–3 randomly chosen bots */
export async function startCompetition(durationHours = 0): Promise<{ ok: boolean; botNames: string[] }> {
  const users = await getBotUsers();
  const enabled = users.filter((u) => u.enabled);
  if (enabled.length < 2) return { ok: false, botNames: [] };

  // Pick 2 or 3 bots at random — different personalities for variety
  const count = Math.random() < 0.4 ? 3 : 2;
  const shuffled = [...enabled].sort(() => Math.random() - 0.5);
  const competitors = shuffled.slice(0, count);

  // Auto pick duration: 6–14 hours if not specified
  const hours = durationHours > 0 ? durationHours : 6 + Math.floor(Math.random() * 9);
  const speedMs = 90_000 + Math.floor(Math.random() * 90_000); // 90s – 3 min per win

  const state: CompetitionState = {
    botIds: competitors.map((c) => c.id),
    startedAt: Date.now(),
    endsAt: Date.now() + hours * 3_600_000,
    speedMs,
  };

  await redis.set(COMPETITION_KEY, JSON.stringify(state), "EX", hours * 3600 + 300);
  return { ok: true, botNames: competitors.map((c) => c.name) };
}

export async function getCompetition(): Promise<CompetitionState | null> {
  const raw = await redis.get(COMPETITION_KEY);
  if (!raw) return null;
  const c: CompetitionState = JSON.parse(raw);
  if (Date.now() > c.endsAt) {
    await redis.del(COMPETITION_KEY);
    return null;
  }
  return c;
}

export async function stopCompetition(): Promise<void> {
  await redis.del(COMPETITION_KEY);
}

// ── Auto-schedule ──────────────────────────────────────────────────────────────

export async function setAutoMode(enabled: boolean): Promise<void> {
  if (enabled) await redis.set(AUTO_MODE_KEY, "1");
  else await redis.del(AUTO_MODE_KEY);
}

export async function isAutoModeEnabled(): Promise<boolean> {
  return (await redis.get(AUTO_MODE_KEY)) === "1";
}

interface AutoSchedule {
  onHour: number;   // when to start (0–23, IST)
  offHour: number;  // when to stop
  date: string;
}

async function _getDailySchedule(): Promise<AutoSchedule> {
  const today = new Date().toISOString().split("T")[0];
  try {
    const raw = await redis.get(AUTO_SCHEDULE_KEY);
    if (raw) {
      const s: AutoSchedule = JSON.parse(raw);
      if (s.date === today) return s;
    }
  } catch {}

  // Create a fresh schedule for today
  const onHour = 8 + Math.floor(Math.random() * 5);    // 8–12 IST start
  const duration = 8 + Math.floor(Math.random() * 7);  // 8–14 h active
  const offHour = (onHour + duration) % 24;
  const schedule: AutoSchedule = { onHour, offHour, date: today };
  await redis.set(AUTO_SCHEDULE_KEY, JSON.stringify(schedule), "EX", 86400);
  return schedule;
}

async function _runAutoScheduleCheck(): Promise<void> {
  if (!(await isAutoModeEnabled())) return;

  const schedule = await _getDailySchedule();
  const nowHour = new Date(
    new Date().toLocaleString("en-US", { timeZone: env.TIME_ZONE || "Asia/Kolkata" }),
  ).getHours();

  const active =
    schedule.onHour < schedule.offHour
      ? nowHour >= schedule.onHour && nowHour < schedule.offHour
      : nowHour >= schedule.onHour || nowHour < schedule.offHour; // wraps midnight

  const currentlyOn = await isBotModeEnabled();

  if (active && !currentlyOn) {
    await setBotMode(true);
    // Randomly start a competition ~40% of the time
    if (Math.random() < 0.4) {
      await startCompetition();
    }
  } else if (!active && currentlyOn) {
    // Only turn off if it was auto-started (don't kill manually enabled sessions)
    const autoStartedKey = "botmode:auto_started";
    const wasAutoStarted = await redis.get(autoStartedKey);
    if (wasAutoStarted) {
      await setBotMode(false);
      await stopCompetition();
      await redis.del(autoStartedKey);
    }
  } else if (active && currentlyOn) {
    await redis.set("botmode:auto_started", "1", "EX", 86400);
  }
}

// ── Main tick ──────────────────────────────────────────────────────────────────
export async function runBotPlayTick(): Promise<void> {
  if (!(await isBotModeEnabled())) return;

  const [users, competition] = await Promise.all([getBotUsers(), getCompetition()]);
  const enabledBots = users.filter((u) => u.enabled);
  if (enabledBots.length === 0) return;

  const knownChats = await _getKnownChats();
  if (knownChats.length === 0) return;

  for (const botUser of enabledBots) {
    // Stagger: bot hasn't woken up yet after mode was enabled
    if (!(await isBotAwake(botUser.id))) continue;

    // Determine effective speed (competition bots play faster)
    const inCompetition = competition?.botIds.includes(botUser.id) ?? false;
    const effectiveSpeed = inCompetition ? competition!.speedMs : botUser.speedMs;

    const ready = await isBotReadyToPlay(botUser.id, effectiveSpeed);
    if (!ready) continue;

    const dailyScore = await getBotDailyScore(botUser.id);
    if (dailyScore >= botUser.dailyLimit) continue;

    const chatId = knownChats[Math.floor(Math.random() * knownChats.length)];
    const wordLen = botUser.modes[Math.floor(Math.random() * botUser.modes.length)];
    const wordList = ALL_WORDS[wordLen];
    wordList[Math.floor(Math.random() * wordList.length)].toUpperCase();

    // Score: personality-based so burst bots hit 80–140 pts/min
    let rawScore: number;
    if (inCompetition) {
      rawScore = 100 + Math.floor(Math.random() * 61); // competition boost: 100–160
    } else {
      switch (botUser.personality) {
        case "burst":  rawScore = 80  + Math.floor(Math.random() * 61); break; // 80–140
        case "fast":   rawScore = 40  + Math.floor(Math.random() * 41); break; // 40–80
        case "medium": rawScore = 15  + Math.floor(Math.random() * 26); break; // 15–40
        case "slow":
        default:       rawScore = 8   + Math.floor(Math.random() * 13); break; // 8–20
      }
    }
    const botScore = Math.min(rawScore, botUser.dailyLimit - dailyScore);
    if (botScore <= 0) continue;

    // Ensure bot user exists in users table
    await db
      .insertInto("users")
      .values({ id: botUser.numId.toString(), name: botUser.name, username: null, dmStarted: true })
      .onConflict((oc) => oc.column("id").doUpdateSet({ name: botUser.name }))
      .execute()
      .catch(() => {});

    // Inject score with chatId = "bot_mode" so it ONLY appears in Global leaderboard.
    // "This Chat" filters by the real group chatId so "bot_mode" entries are excluded.
    await db
      .insertInto("leaderboard")
      .values({ score: botScore, chatId: "bot_mode", userId: botUser.numId.toString(), wordLength: wordLen })
      .execute()
      .catch(() => {});

    await Promise.all([
      addBotDailyScore(botUser.id, botScore),
      markBotPlayed(botUser.id),
    ]);

    // Occasionally add a tiny random jitter to next play time (human feel)
    if (Math.random() < 0.3) {
      const jitter = Math.floor(Math.random() * 2 * 60_000);
      await redis.set(
        `botmode:last:${botUser.id}`,
        (Date.now() - jitter).toString(),
        "EX",
        86400,
      ).catch(() => {});
    }
  }
}

// ── Autobot — fully autonomous 24/7 controller ────────────────────────────────
export async function isAutobotEnabled(): Promise<boolean> {
  return (await redis.get(AUTOBOT_KEY)) === "1";
}

export async function setAutobot(enabled: boolean): Promise<void> {
  if (enabled) {
    await redis.set(AUTOBOT_KEY, "1");
    await _runAutobotTick(); // kick off immediately
  } else {
    await redis.del(AUTOBOT_KEY);
    await redis.del(AUTOBOT_WAKE_KEY);
  }
}

/**
 * Autonomous controller — runs every 30 min.
 * Controls bot mode on/off, competitions, and speed variation without any
 * owner input. Simulates human-like activity rhythms (active peak hours,
 * lighter at night, random breaks and competition bursts).
 */
async function _runAutobotTick(): Promise<void> {
  if (!(await isAutobotEnabled())) return;

  const nowIST = new Date(
    new Date().toLocaleString("en-US", { timeZone: env.TIME_ZONE || "Asia/Kolkata" }),
  );
  const hour = nowIST.getHours();
  const currentlyOn = await isBotModeEnabled();

  // 6am–2am = active window (20h), 2am–6am = quiet window (4h)
  const isActiveHour = hour >= 6 || hour < 2;
  const isQuietHour  = hour >= 2 && hour < 6;

  // ── Wake from scheduled break ───────────────────────────────────────────
  const nextWake = await redis.get(AUTOBOT_WAKE_KEY);
  if (nextWake && Date.now() >= parseInt(nextWake)) {
    await redis.del(AUTOBOT_WAKE_KEY);
    if (!currentlyOn && isActiveHour) {
      await setBotMode(true);
    }
  }

  // ── Active hours: keep bot mode alive ──────────────────────────────────
  if (isActiveHour && !currentlyOn && !(await redis.get(AUTOBOT_WAKE_KEY))) {
    await setBotMode(true);
    if (Math.random() < 0.3) await startCompetition(1);
  }

  // ── Quiet hours: take random 1–2 h breaks ─────────────────────────────
  if (isQuietHour && currentlyOn && Math.random() < 0.45) {
    const wasAuto = await redis.get("botmode:auto_started");
    if (wasAuto) {
      await setBotMode(false);
      await stopCompetition();
      const wakeAfterMs = (60 + Math.floor(Math.random() * 60)) * 60_000;
      await redis.set(AUTOBOT_WAKE_KEY, (Date.now() + wakeAfterMs).toString(), "EX", 7200);
    }
  }

  // ── Randomly start competition ~every 3–4 h during active window ──────
  if (currentlyOn && isActiveHour) {
    const competition = await getCompetition();
    if (!competition && Math.random() < 0.08) { // ~8%/30min ≈ 1 per ~6 ticks (3h)
      const durationH = 0.5 + Math.random() * 1.5; // 30min–2h
      await startCompetition(Math.ceil(durationH));
    }
  }

  // ── Slightly vary bot speeds every few ticks to avoid patterns ─────────
  if (Math.random() < 0.15) {
    const users = await getBotUsers();
    let changed = false;
    for (const u of users) {
      if (Math.random() < 0.15) {
        const [min, max] = SPEED_PROFILE[u.personality];
        u.speedMs = min + Math.floor(Math.random() * (max - min));
        changed = true;
      }
    }
    if (changed) await saveBotUsers(users);
  }

  // Mark as auto-started so auto-stop logic knows it was us
  if (currentlyOn) {
    await redis.set("botmode:auto_started", "1", "EX", 86400).catch(() => {});
  }
}

// ── Crons ──────────────────────────────────────────────────────────────────────
/** Main tick — runs every 10 s; each bot controls own firing interval */
export const botModeCron = new CronJob(
  "*/10 * * * * *",
  async () => { try { await runBotPlayTick(); } catch {} },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);

/** Auto-schedule check — every 5 min */
export const autoScheduleCron = new CronJob(
  "0 */5 * * * *",
  async () => { try { await _runAutoScheduleCheck(); } catch {} },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);

/** Autobot tick — every 30 min; fully autonomous controller */
export const autobotCron = new CronJob(
  "0 */30 * * * *",
  async () => { try { await _runAutobotTick(); } catch {} },
  null,
  false,
  env.TIME_ZONE || "Asia/Kolkata",
);
