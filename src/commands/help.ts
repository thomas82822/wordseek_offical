import { Composer, InlineKeyboard } from "grammy";

import { env } from "../config/env";
import { isBotAdmin } from "../util/guards";
import { CommandsHelper } from "../util/commands-helper";
import { CHANNEL_LINK, DISCUSSION_GROUP, UPDATES_CHANNEL, pe } from "../config/constants";

const composer = new Composer();

type HelpSection = "howto" | "scores" | "group" | "other" | "admin";

export function formatActiveButton(label: string, active: boolean) {
  return active ? `« ${label} »` : label;
}

function getTimezoneLabel(): string {
  const tz = env.TIME_ZONE || "Asia/Kolkata";

  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "shortOffset",
    });

    const parts = formatter.formatToParts(now);
    const tzName = parts.find((p) => p.type === "timeZoneName")?.value;

    const [, cityRaw] = tz.split("/");
    const city = cityRaw?.replace(/_/g, " ") ?? tz;

    if (city && tzName) {
      return `${city} time (${tzName})`;
    }
    if (city) {
      return `${city} time`;
    }
    return tz;
  } catch {
    return tz;
  }
}

export function getMainHelpKeyboard(
  shouldShowAdmin: boolean,
  active: HelpSection = "howto",
) {
  const keyboard = new InlineKeyboard();

  // Row 1: game commands — visible to everyone
  keyboard.text(formatActiveButton("🎮 How to Play", active === "howto"), "help_howto");
  keyboard.text(formatActiveButton("🏆 Leaderboard", active === "scores"), "help_scores");

  // Row 2+: admin/owner-only sections
  if (shouldShowAdmin) {
    keyboard.row();
    keyboard.text(formatActiveButton("⚙️ Group Settings", active === "group"), "help_group");
    keyboard.text(formatActiveButton("📋 Other Commands", active === "other"), "help_other");
    keyboard.row().text(formatActiveButton("👑 Admin Commands", active === "admin"), "help_admin");
  }

  keyboard
    .row()
    .url("📢 Updates", UPDATES_CHANNEL)
    .url("📱 Channel", CHANNEL_LINK)
    .url("💬 Discussion", DISCUSSION_GROUP);

  return keyboard;
}

export function getHowToPlayMessage() {
  const timezoneLabel = getTimezoneLabel();

  return `<b>${pe("🎮")} How to Play Wordseek Bot</b>

<blockquote>1. Start a game using /new, /new4, /new5, or /new6
2. Guess the hidden word
3. After each guess, you'll get color hints:
   🟩 Correct letter in the right spot
   🟨 Correct letter in the wrong spot
   🟥 Letter not in the word
4. First person to guess correctly wins!
5. Maximum 30 guesses per game</blockquote>

<b>Word Length Modes:</b>
<blockquote>• /new → Start default 5-letter game
• /new 4 → Start specific length (4, 5, or 6)
• /new4 → Start 4-letter game
• /new5 → Start 5-letter game
• /new6 → Start 6-letter game</blockquote>

<b>Basic Commands:</b>
• /new - Start a new game (default 5 letters)
• /new4 - Start a 4-letter game
• /new5 - Start a 5-letter game
• /new6 - Start a 6-letter game
• /end - End current game (voting or admin only)
• /help - Show this help menu
• /daily - Play Daily Wordseek (private chat only)
• /pausedaily - Pause Daily mode and go back to normal games

<b>Daily Mode (Private Chat Only):</b>
<blockquote>• Start a daily game using /daily command
• Works like New York Times Wordle: one fixed word per day
• You only get 6 guesses per daily puzzle
• A new puzzle unlocks every day at 06:00 in <code>${timezoneLabel}</code>
• You build a streak by solving the daily puzzle without failing
• You cannot play normal Wordseek and Daily at the same time:
  - If a normal game is running, end it before using /daily
  - If Daily is active, use /pausedaily to play normal Wordseek again</blockquote>`;
}

export function getScoresMessage() {
  return `<b>${pe("🏆")} Leaderboard &amp; Scores</b>

<b>Quick Examples:</b>
<blockquote><code>/leaderboard</code> - Group, today (default 5-letter)
<code>/leaderboard 4</code> - 4-letter leaderboard (group, today)
<code>/leaderboard global week 6</code> - Global rankings this week (6-letter mode)
<code>/leaderboard month</code> - This group's monthly leaderboard

<code>/score</code> - Your score (group, today, 5-letter by default)
<code>/score 6</code> - Your 6-letter stats
<code>/score @username global all 4</code> - Full 4-letter global history for a user
<code>/score 123456789 month</code> - Monthly stats for a user</blockquote>

<b>Leaderboard Command</b>
<blockquote><b>Syntax:</b> <code>/leaderboard [scope] [period] [length]</code>

All parameters are optional and can be used in any order.

<b>Scope:</b>
• <code>group</code> (default) - Current group only
• <code>global</code> - All groups combined

<b>Period:</b>
• <code>today</code> (default)
• <code>week</code>
• <code>month</code>
• <code>year</code>
• <code>all</code>

<b>Length:</b>
• <code>4</code> - 4-letter mode
• <code>5</code> - 5-letter mode (default)
• <code>6</code> - 6-letter mode</blockquote>

<b>Score Command</b>
<blockquote><b>Syntax:</b> <code>/score [target] [scope] [period] [length]</code>

All parameters are optional and can be used in any order.

<b>Target (optional):</b>
• Leave empty for your own score
• <code>@username</code> - Look up by username
• <code>user_id</code> - Look up by Telegram user ID

<b>Scope, period &amp; length:</b>
Same as <code>/leaderboard</code></blockquote>`;
}

export function getGroupSettingsMessage() {
  return `<b>${pe("⚙️")} Group Settings (Admin Only)</b>

<b>Authorized Users</b>
<blockquote><b>/seekauth</b> – Manage users who can end games without a vote.

<b>Usage:</b>
• <code>/seekauth @username</code> – Authorize a user
• <code>/seekauth remove @username</code> – Remove authorization
• <code>/seekauth list</code> – List all authorized users

You can also use a user ID or reply to a message instead of @username.</blockquote>

<b>Game Topic (Forum Groups)</b>
<blockquote><b>/setgametopic</b> – Restrict games to one or more topics
Run this command <i>inside the topic</i> where you want games to be played.
After setting, the bot will only run games in that topic.

<b>/unsetgametopic</b> – Remove topic restriction
Usage: <code>/unsetgametopic</code>
After unsetting, the bot can run games in any topic in the group again.

<b>/allowonlylen</b> – Restrict allowed word lengths in this topic
Usage: <code>/allowonlylen 4</code> or <code>/allowonlylen 5 6</code>
Run this inside a game topic.

You can allow one or more of: 4, 5, 6.
The first number you specify becomes the default length for <code>/new</code> in that topic.

If not configured, all lengths (4, 5, 6) are allowed by default.

<b>/recreatetopic</b> – Auto-recreate topic when it expires
Usage: <code>/recreatetopic on</code> or <code>/recreatetopic off</code>
Run this command inside a game topic.

When enabled, if the topic automatically expires (Telegram forum feature), the bot will recreate the same topic so games can continue.</blockquote>`;
}

export function getOtherCommandsMessage() {
  return `<b>${pe("📋")} Other Commands</b>

<blockquote><b>/id</b> - Get message information
Reply to any message to see:
• Message ID and date
• User information
• Chat information
• Forward information (if forwarded)
• File IDs for media

<b>Only admins can use in case of a group</b>

<b>/claimbonus</b> - Claim your daily random bonus score (DM only)
Requires 50,000 total score. A bonus drop is reserved for you until you reach it!

<b>/requesttransfer</b> - Request score transfer between accounts
Usage: <code>/requesttransfer &lt;old_account&gt; &lt;new_account&gt;</code></blockquote>`;
}

export function getAdminCommandsMessage() {
  return `<b>${pe("👑")} Admin Commands (Bot Owner/Admin Only)</b>

<blockquote><b>/ban [user_id|@username] [reason]</b>
Ban a user from using the bot globally (works anywhere)
<i>Note: Owners can never be banned.</i>

<b>/unban [user_id|@username]</b>
Unban a previously banned user

<b>/unfreeze [user_id|@username]</b>
Unfreeze a user whose score was frozen by anti-cheat

<b>/freezelist</b>
Show all currently frozen users

<b>/giveadmin [user_id|@username]</b>
Grant bot-admin rights to a user (also supports reply)

<b>/removeadmin [user_id|@username]</b>
Revoke bot-admin rights from a user

<b>/adminlist</b>
List all DB-granted bot admins

<b>/addscore [user_id|@username] &lt;amount&gt; [4|5|6]</b>
Manually add score to a user's leaderboard

<b>/stats</b>
View bot statistics including memory, CPU, users, groups

<b>/transfer &lt;from_user&gt; &lt;to_user&gt;</b>
Transfer scores between users (admin version)

<b>/broadcast</b>
Broadcast a message to all broadcastable chats
Reply to a message with this command

<b>/promoson</b> / <b>/promosoff</b>
Enable or disable hourly promo messages in all groups

<b>/track &lt;chat_id&gt;</b>
Start tracking a chat (for detecting cheaters)

<b>/untrack &lt;chat_id&gt;</b>
Stop tracking a previously tracked chat

<b>/tracklist</b>
Show all currently tracked chats

<b>── Owner-Only Commands ──</b>

<b>/setstart</b>
Change the bot's /start banner image (send this, then send a photo)

<b>/resetstart</b>
Reset the start banner back to the default image

<b>/downloaddata</b>
Download all bot data (users, scores, bans, etc.) as a JSON file

<b>/syncgithub</b>
Download the entire GitHub repo as a ZIP file (all files, no skipping)

<b>/userdetails &lt;user_id&gt;</b>
Full breakdown for a user: profile, all group chats, wins by chat &amp; mode, game timing, recently started games</blockquote>`;
}

composer.command("help", async (ctx) => {
  if (!ctx.from) return;

  const shouldShowAdmin =
    (await isBotAdmin(ctx.from.id)) && ctx.chat.type === "private";
  const keyboard = getMainHelpKeyboard(shouldShowAdmin, "howto");

  await ctx.reply(getHowToPlayMessage(), {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
});

CommandsHelper.addNewCommand(
  "help",
  "Get help on how to play and commands list",
);

export const helpCommand = composer;
