import { Queue } from "bullmq";
import { Worker } from "bullmq";

import { bot } from "../config/bot";
import { redis, createBullMQConnection } from "../config/redis";
import { captchaSchema } from "../schemas";
import { formatUserMention } from "../commands/captcha";

// Dedicated connections for BullMQ — must NOT share the main `redis` instance.
// BullMQ v5 duplicates the connection you pass and adds its own commandTimeout.
// On Heroku, when that duplicated connection drops, every pending command fires
// "Command timed out" every ~3 seconds, crashing the bot in a loop.
// Using fresh dedicated connections breaks this dependency.
const queueConnection = createBullMQConnection();
const workerConnection = createBullMQConnection();

export const captchaQueue = new Queue("captcha-expiry", {
  connection: queueConnection,
});

new Worker(
  "captcha-expiry",
  async (job) => {
    const { chatId, userId, messageId } = job.data;

    const key = `captcha:${chatId}:${userId}`;
    const raw = await redis.get(key);

    if (!raw) return;

    const session = captchaSchema.parse(JSON.parse(raw));

    await redis.del(key);

    const mention = formatUserMention({
      id: session.userId,
      name: session.name,
      username: session.username,
    });

    try {
      await bot.api.editMessageText(
        chatId,
        messageId,
        `⏰ <b>Verification timed out</b>\n\n${mention} didn't complete it in time.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Edit failed:", e);
    }

    try {
      await bot.api.sendMessage(
        session.adminId,
        `⏰ ${mention} did not complete the captcha in time.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      console.error("Admin notify failed:", e);
    }
  },
  {
    connection: workerConnection,
  },
);
