import { z } from "zod";

export const env = z
  .object({
    BOT_TOKEN: z.string().min(1, { message: "BOT_TOKEN is required" }),
    DATABASE_URL: z.string().min(1, { message: "DATABASE_URL is required" }),
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    ADMIN_USERS: z
      .string()
      .default("")
      .transform((val) => val.split(",").filter(Boolean).map(Number)),
    REDIS_URI: z.string().default("redis://127.0.0.1:6379"),
    CUSTOM_API_ROOT: z
      .string()
      .url({ message: "CUSTOM_API_ROOT must be a valid URL" })
      .default("https://api.telegram.org"),
    LOGS_CHANNEL: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : undefined)),
    // Separate channel for anti-cheat / suspicious-activity alerts (freezes, hack commands, etc.)
    ANTICHEAT_LOGS_CHANNEL: z
      .string()
      .optional()
      .transform((v) => (v ? Number(v) : undefined)),
    TIME_ZONE: z.string().optional().default("Asia/Kolkata"),
    DAILY_WORDLE_START_DATE: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format, expected YYYY-MM-DD")
      .optional()
      .default("2025-01-01")
      .transform((val) => new Date(val)),
    DAILY_WORDLE_SECRET: z
      .string()
      .min(1, { message: "DAILY_WORDLE_SECRET is required" }),
    // Comma-separated Gemini API keys
    GEMINI_API_KEYS: z
      .string()
      .transform((val) =>
        val
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      )
      .optional()
      .default([]),
    // Public HTTPS root of the bot's Heroku app (no trailing slash).
    // When set, the bot uses webhook mode (instant updates) instead of long polling.
    // Set via: heroku config:set APP_URL=https://your-app-name.herokuapp.com
    // z.preprocess converts empty string / null / undefined → undefined so zod's
    // .url() validator doesn't crash when the Heroku form leaves this field blank.
    APP_URL: z
      .preprocess(
        (v) => (v == null || v === "" ? undefined : v),
        z.string().url().optional(),
      )
      .transform((v) => v?.replace(/\/$/, "")), // strip trailing slash
    // GitHub credentials for live data persistence
    GITHUB_TOKEN: z.string().optional().default(""),
    GITHUB_OWNER: z.string().optional().default("thomas91929"),
    GITHUB_REPO: z.string().optional().default("wordseek_offical-"),
    GITHUB_BRANCH: z.string().optional().default("main"),
  })
  .parse({
    ...process.env,
    // Heroku's Redis add-on sets REDIS_URL, but this app is configured to
    // read REDIS_URI. Fall back to REDIS_URL automatically so the addon
    // works out of the box without a manual `heroku config:set` step.
    REDIS_URI: process.env.REDIS_URI || process.env.REDIS_URL,
  });
