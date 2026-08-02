import { Composer, InlineKeyboard } from "grammy";

import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";

import { env } from "../config/env";
import { redis } from "../config/redis";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";
import { pushBinaryFileToGitHub } from "../services/github-sync";

const composer = new Composer();

const AWAITING_BANNER_KEY = "owner:awaiting_banner";
const BANNER_TTL_SECONDS = 300;
const LOCAL_BANNER_PATH = "./src/data/banner.png";
const GITHUB_BANNER_PATH = "src/data/banner.png";

function buildSetStartKeyboard() {
  return new InlineKeyboard()
    .text("📸 Upload New Banner Now", "setstart_rearm");
}

async function armBannerUpload(ownerId: number) {
  await redis.set(AWAITING_BANNER_KEY, ownerId.toString(), "EX", BANNER_TTL_SECONDS);
}

composer.command("setstart", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply(`${pe("⚠️")} Use this command in my DM.`);
  }

  await armBannerUpload(ctx.from.id);

  await ctx.reply(
    `${pe("📸")} <b>Set Start Banner</b>\n\n` +
      `<blockquote>Send me a photo to use as the bot's start banner.\n\n` +
      `${pe("⏳")} You have 5 minutes.\n` +
      `The image is also saved permanently to GitHub, so it survives restarts and redeploys.\n` +
      `Use /resetstart to go back to the default image, or tap the button below if your 5 minutes run out.</blockquote>`,
    { parse_mode: "HTML", reply_markup: buildSetStartKeyboard() },
  );
});

// Owner tapped the "Upload New Banner Now" button inside /setstart — re-arms
// the upload window without needing to retype the command.
composer.callbackQuery("setstart_rearm", async (ctx) => {
  if (!ctx.from || !env.ADMIN_USERS.includes(ctx.from.id)) {
    return ctx.answerCallbackQuery({
      text: "Only the bot owner can do this.",
      show_alert: true,
    });
  }

  await armBannerUpload(ctx.from.id);
  await ctx.answerCallbackQuery({ text: "Ready! Send me a photo now." });

  await ctx.editMessageText(
    `${pe("📸")} <b>Set Start Banner</b>\n\n` +
      `<blockquote>Send me a photo now to use as the bot's start banner.\n\n` +
      `${pe("⏳")} You have 5 minutes.</blockquote>`,
    { parse_mode: "HTML", reply_markup: buildSetStartKeyboard() },
  );
});

composer.command("resetstart", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") {
    return ctx.reply(`${pe("⚠️")} Use this command in my DM.`);
  }

  await redis.del("bot:banner_file_id");
  await redis.del(AWAITING_BANNER_KEY);

  await ctx.reply(
    `${pe("✅")} <b>Banner Reset</b>\n\nThe bot will now use the default start banner.`,
    { parse_mode: "HTML" },
  );
});

// Handle photo sent by owner after /setstart
composer.on("message:photo", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;
  if (ctx.chat.type !== "private") return;

  const awaiting = await redis.get(AWAITING_BANNER_KEY);
  if (!awaiting || awaiting !== ctx.from.id.toString()) return;

  const photo = ctx.message.photo.at(-1);
  if (!photo) return;

  await redis.set("bot:banner_file_id", photo.file_id);
  await redis.del(AWAITING_BANNER_KEY);

  // Persist the actual image bytes so the banner survives beyond Telegram's
  // file_id / Redis (both of which can be lost on a Redis flush or if
  // Telegram invalidates the file_id). We save it both to GitHub (permanent,
  // versioned) and to the local disk (used as start.ts's offline fallback).
  let githubSaved = false;
  try {
    const file = await ctx.api.getFile(photo.file_id);
    if (file.file_path) {
      const fileRes = await fetch(
        `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`,
      );
      if (fileRes.ok) {
        const bytes = Buffer.from(await fileRes.arrayBuffer());

        await mkdir(dirname(LOCAL_BANNER_PATH), { recursive: true });
        await writeFile(LOCAL_BANNER_PATH, bytes);

        githubSaved = await pushBinaryFileToGitHub(
          GITHUB_BANNER_PATH,
          bytes,
          `chore: update start banner [${new Date().toISOString()}]`,
        );
      }
    }
  } catch (err) {
    console.error("Failed to persist start banner to GitHub:", err);
  }

  await ctx.replyWithPhoto(photo.file_id, {
    caption:
      `${pe("✅")} <b>Banner Updated!</b>\n\n` +
      `<blockquote>This image will now be shown when users send /start.\n` +
      `${githubSaved ? `${pe("☁️")} Permanently saved to GitHub — safe even if Redis is cleared.` : "⚠️ Could not save to GitHub (check GITHUB_TOKEN) — currently only cached in Redis."}\n` +
      `Use /resetstart to go back to the default banner.</blockquote>`,
    parse_mode: "HTML",
  });
});

CommandsHelper.addNewCommand("setstart", "Change the bot's start banner image (owner only)", true);
CommandsHelper.addNewCommand("resetstart", "Reset start banner to default (owner only)", true);

export const setStartCommand = composer;
