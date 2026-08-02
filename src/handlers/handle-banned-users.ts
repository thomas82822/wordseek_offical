import { Composer, InlineKeyboard } from "grammy";

import { env } from "../config/env";
import { OWNER_LINK } from "../config/constants";
import { isUserBanned } from "../util/guards";

const composer = new Composer();

composer.on("message", async (ctx, next) => {
  // Owners are NEVER blocked — no matter what
  if (env.ADMIN_USERS.includes(ctx.from.id)) return await next();

  // Use Redis-cached check (falls back to DB on cache miss).
  // This avoids a raw DB query on every single group message.
  const banned = await isUserBanned(ctx.from.id.toString());
  if (!banned) return await next();

  const keyboard = new InlineKeyboard().url("📩 Appeal to Owner", OWNER_LINK);
  const banMessage =
    "🚫 <b>You are banned from using WordSeek.</b>\n\n" +
    "If you believe this is a mistake, please contact the owner.";

  if (ctx.chat.type === "private") {
    return ctx.reply(banMessage, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    const me = ctx.me.id.toString();
    const botMentioned =
      ctx.message.reply_to_message?.from?.id.toString() === me;

    if (botMentioned) {
      return ctx.reply(banMessage, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  }
});

export const handleBannedUsers = composer;
