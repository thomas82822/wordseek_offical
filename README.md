# Wordseek Bot

A competitive Wordle-style Telegram game bot. Play in groups or DMs with leaderboards, daily puzzles, and more.

## Quick Deploy to Heroku

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy)

Or manually:

```bash
bash heroku-setup.sh your-heroku-app-name
```

## Required Environment Variables

| Variable | Description | Required |
|---|---|---|
| `BOT_TOKEN` | Telegram Bot Token from @BotFather | ✅ |
| `DATABASE_URL` | PostgreSQL connection string (auto-set by Heroku addon) | ✅ |
| `REDIS_URL` | Redis connection string (auto-set by Heroku addon) | ✅ |
| `ADMIN_USERS` | Your Telegram User ID(s), comma-separated | ✅ |
| `APP_URL` | Public HTTPS URL of your Heroku app (enables webhook) | Recommended |
| `TIME_ZONE` | Timezone for daily resets, e.g. `Asia/Kolkata` | ✅ |
| `DAILY_WORDLE_SECRET` | Random secret for daily puzzle signing | ✅ |
| `DAILY_WORDLE_START_DATE` | Daily puzzle start date `YYYY-MM-DD` | ✅ |
| `LOGS_CHANNEL` | Telegram channel ID for activity logs | Optional |
| `ANTICHEAT_LOGS_CHANNEL` | Telegram channel ID for anti-cheat logs | Optional |
| `GITHUB_TOKEN` | GitHub PAT (repo scope) for live data persistence | Optional |
| `GITHUB_OWNER` | GitHub username for data persistence | Optional |
| `GITHUB_REPO` | GitHub repo name for data persistence | Optional |
| `GEMINI_API_KEYS` | Gemini API keys for word meaning generation | Optional |

## Stack

- **Runtime:** Bun
- **Bot framework:** grammY
- **Database:** PostgreSQL + Kysely ORM
- **Cache:** Redis (ioredis)
- **Platform:** Heroku

## Local Development

```bash
# Install dependencies
bun install

# Run migrations
bun run db:migrate

# Start bot (watch mode)
bun run dev
```

## Commands

| Command | Description |
|---|---|
| `/new` | Start a new game (5-letter default) |
| `/new4` `/new5` `/new6` | Start game with specific word length |
| `/end` | End current game (admin or vote) |
| `/leaderboard` | View group/global leaderboard |
| `/score` | View your or another user's score |
| `/daily` | Play today's Daily WordSeek puzzle |
| `/dailyreward` | Claim free daily score reward (DM only) |
| `/claimbonus` | Claim bonus score (DM only, need 1k+ score) |
| `/requesttransfer` | Request a score transfer between accounts |
| `/help` | Full command list and help menu |

## Bot Mode (Owner Only)

Bot Mode simulates human-like player activity on the leaderboard.

| Command | Description |
|---|---|
| `/botmode on\|off` | Toggle bot mode |
| `/autobotmode on\|off` | Auto-schedule bots daily |
| `/startcompetition [hours]` | Race 2–3 bots against each other |
| `/stopcompetition` | Stop active competition |
| `/botlist` | List all bots and their daily progress |
| `/scanname` | Assign real user names to bots |
| `/botsetlimit <id\|all> <pts>` | Set daily score limit |
| `/botsetspeed <id\|all> <secs>` | Set play interval |
| `/botreset <id\|all>` | Reset daily counters |
| `/botname <id> <name>` | Rename a bot |

**Bot behaviour:**
- Scores grow gradually (human-like small steps)
- Daily limits vary per bot: 8,000–55,000 pts (highest can reach 50k+)
- Bot scores stored as `chatId = "bot_mode"` — only appear in **Global** leaderboard, not **This Chat**

## Fixes in This Version

- ✅ `requesttransfer`: Added **"Requested From"** field to transfer request message
- ✅ `requesttransfer` / `transfer`: Fixed "Cannot transfer to the same account" parsing (early string check + bot filter)
- ✅ DM gameplay: `/new` now works in private chats (group-only guards bypassed for DMs)
- ✅ Bot mode: Human-like score growth, varied daily limits (8k–55k), scores excluded from "This Chat" leaderboard
- ✅ `botmode.ts`: Cleaned up and consistent with `bot-mode` service interface
