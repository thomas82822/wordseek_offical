import { run } from "@grammyjs/runner";
import { createServer } from "http";

import { bot } from "./config/bot";
import { commands } from "./commands/index";
import { errorHandler } from "./handlers/error-handler";
import { onBotAddedInChat } from "./handlers/on-bot-added-in-chat";
import { onMessageHandler } from "./handlers/on-message";
import { userAndChatSyncHandler } from "./handlers/user-and-chat-sync-handler";
import { topicEditedHandler } from "./handlers/topic-edited-handler";
import { trackMessagesHandler } from "./handlers/track-messages-handler";
import { handleBannedUsers } from "./handlers/handle-banned-users";
import { callbackQueryHandler } from "./handlers/callback-query";
import { dailyWordleCron } from "./services/daily-wordle-cron";
import { hourlyPromoCron } from "./commands/hourlypromo";
import { githubSyncCron, ownerBackupCron, pullBinaryFileFromGitHub, restoreFromGitHub } from "./services/github-sync";
import { autobotCron, autoScheduleCron, botModeCron, initBotUsers } from "./services/bot-mode";
import { autoGameCron } from "./services/auto-game";
import { CommandsHelper } from "./util/commands-helper";
import { env } from "./config/env";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";

const LOCAL_BANNER_PATH = "./src/data/banner.png";
const GITHUB_BANNER_PATH = "src/data/banner.png";

async function main() {
  console.log("Starting Wordseek Bot...");

  // Must initialize before handling any webhook updates
  await bot.init();
  console.log(`Bot initialized: @${bot.botInfo.username}`);

  // Register middleware (order matters)
  bot.use(userAndChatSyncHandler);
  bot.use(handleBannedUsers);
  bot.use(commands);
  bot.use(callbackQueryHandler);
  bot.use(onMessageHandler);
  bot.use(onBotAddedInChat);
  bot.use(topicEditedHandler);
  bot.use(trackMessagesHandler);

  // Error handler
  bot.catch(errorHandler);

  // Start cron jobs
  dailyWordleCron.start();
  hourlyPromoCron.start();
  autoGameCron.start();
  botModeCron.start();
  autoScheduleCron.start();
  autobotCron.start();
  console.log("Auto-game, bot-mode, auto-schedule, and autobot crons started");

  if (env.GITHUB_TOKEN) {
    githubSyncCron.start();
    ownerBackupCron.start();
    console.log("GitHub auto-sync cron started (every 5 hours) + owner backup cron (every 24h)");
  }

  // Set bot commands menu (non-blocking)
  CommandsHelper.setCommands()
    .then(() => console.log("Bot commands menu set"))
    .catch((err) => console.error("Failed to set bot commands:", err));

  // Initialize bot users in background
  initBotUsers().catch(() => {});

  // GitHub restore in background — only if DB is empty
  if (env.GITHUB_TOKEN) {
    (async () => {
      await new Promise((r) => setTimeout(r, 5_000));

      console.log("Checking GitHub backup for data restore...");
      const restoreResult = await restoreFromGitHub();
      console.log(restoreResult.message);

      if (!existsSync(LOCAL_BANNER_PATH)) {
        try {
          const bytes = await pullBinaryFileFromGitHub(GITHUB_BANNER_PATH);
          if (bytes) {
            await mkdir(dirname(LOCAL_BANNER_PATH), { recursive: true });
            await writeFile(LOCAL_BANNER_PATH, bytes);
            console.log("Restored start banner from GitHub");
          }
        } catch (err) {
          console.error("Failed to restore start banner from GitHub:", err);
        }
      }
    })();
  }

  // ── Transport ────────────────────────────────────────────────────────────
  if (env.APP_URL) {
    const PORT = parseInt(process.env.PORT || "3000", 10);

    // Pre-allocate a reusable buffer to avoid GC churn on each request
    const server = createServer((req, res) => {
      if (req.method === "GET") {
        res.writeHead(200).end("Wordseek Bot is running ✅");
        return;
      }

      if (req.method === "POST" && req.url === "/webhook") {
        // ── Maximum-speed webhook path ─────────────────────────────────────
        // 1. Ack Telegram IMMEDIATELY (200 OK) before processing — Telegram
        //    marks the update as delivered the instant it sees the 200, so
        //    delivery latency is zero regardless of how long our handler takes.
        // 2. Parse the body and process in the background so we never block
        //    the TCP socket waiting for business logic to finish.
        const chunks: Buffer[] = [];

        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          // Respond to Telegram FIRST — absolutely zero processing delay
          res.writeHead(200).end();

          // Parse and handle asynchronously after Telegram already got its 200
          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const update = JSON.parse(body);
            // Fire-and-forget — errors are caught by bot.catch(errorHandler)
            bot.handleUpdate(update).catch((err) => {
              console.error("[webhook] handleUpdate error:", err);
            });
          } catch (err) {
            console.error("[webhook] Parse error:", err);
          }
        });
        req.on("error", (err) => {
          console.error("[webhook] Request error:", err);
          res.writeHead(200).end(); // still ack so Telegram doesn't retry
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.listen(PORT, async () => {
      try {
        await bot.api.setWebhook(`${env.APP_URL}/webhook`, {
          allowed_updates: ["message", "callback_query", "my_chat_member", "message_reaction"],
          max_connections: 100, // Telegram concurrency: up to 100 simultaneous connections
        });
        console.log(`Webhook mode active: ${env.APP_URL}/webhook  (port ${PORT})`);
      } catch (err) {
        console.error("Failed to set webhook:", err);
      }
    });

    const stopServer = () => {
      console.log("Shutting down...");
      dailyWordleCron.stop();
      hourlyPromoCron.stop();
      autoGameCron.stop();
      botModeCron.stop();
      autoScheduleCron.stop();
      autobotCron.stop();
      if (env.GITHUB_TOKEN) { githubSyncCron.stop(); ownerBackupCron.stop(); }
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", stopServer);
    process.on("SIGTERM", stopServer);

  } else {
    // ── Long-polling mode (local dev / non-Heroku) ───────────────────────
    // Delete any previously set webhook before starting long-polling.
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    const runner = run(bot, {
      runner: {
        fetch: {
          // Pull up to 100 updates per poll for maximum throughput.
          // Telegram delivers them instantly when limit is high.
          limit: 100,
          // Long-poll: Telegram holds the connection and delivers instantly.
          timeout: 30,
          allowed_updates: ["message", "callback_query", "my_chat_member", "message_reaction"],
        },
      },
    });
    console.log(`Long-polling mode (NODE_ENV=${env.NODE_ENV})`);

    const stopBot = () => {
      console.log("Shutting down...");
      runner.isRunning() && runner.stop();
      dailyWordleCron.stop();
      hourlyPromoCron.stop();
      autoGameCron.stop();
      botModeCron.stop();
      autoScheduleCron.stop();
      autobotCron.stop();
      if (env.GITHUB_TOKEN) { githubSyncCron.stop(); ownerBackupCron.stop(); }
      process.exit(0);
    };
    process.on("SIGINT", stopBot);
    process.on("SIGTERM", stopBot);
  }
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
