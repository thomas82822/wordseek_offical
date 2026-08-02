import { Bot } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";

import { env } from "./env.ts";

export const bot = new Bot(env.BOT_TOKEN, {
  client: {
    apiRoot: env.CUSTOM_API_ROOT,
    // Fail fast instead of hanging forever — 20s max per API call
    timeoutSeconds: 20,
    // Allow higher concurrency for webhook mode
    buildUrl: undefined,
  },
});

// Auto-retry on 429 Too Many Requests and transient 5xx errors.
// Without this, rate-limit hits silently drop replies and commands stop working.
// maxRetryAttempts=3, maxDelaySeconds=5 keeps retries fast without hammering Telegram.
bot.api.config.use(
  autoRetry({
    maxRetryAttempts: 3,
    maxDelaySeconds: 5,
    rethrowInternalServerErrors: false,
  }),
);
