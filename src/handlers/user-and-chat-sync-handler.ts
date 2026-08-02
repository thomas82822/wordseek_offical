import { Composer } from "grammy";

import { db } from "../config/db";
import { redis } from "../config/redis";

const composer = new Composer();

/**
 * Sync user + chat to DB — but THROTTLED via Redis.
 *
 * Problem before: this fired 2–3 DB upserts on EVERY single message in every
 * group, even though user names and chat titles rarely change.  On a busy
 * group with 100 msg/min that's 300 pointless DB writes per minute consuming
 * connection-pool slots that the guessing code needs.
 *
 * Fix: use a Redis flag (TTL 5 min) per user and per chat so each DB upsert
 * runs at most once every 5 minutes.  The data is still always up-to-date
 * enough — user renames propagate within 5 min, which is fine.
 *
 * All DB writes remain fire-and-forget (inside async IIFEs) so next() is
 * called immediately and the user sees zero extra latency.
 */
composer.use(async (ctx, next) => {
  try {
    const user = ctx.from;
    const chat = ctx.chat;

    if (user && !user.is_bot) {
      const userId = user.id.toString();
      const userName = user.first_name + (user.last_name ? " " + user.last_name : "");
      const userUsername = user.username || null;

      // Throttle: only sync user to DB once per 5 minutes
      const userSyncKey = `usersync:${userId}`;
      (async () => {
        try {
          const alreadySynced = await redis.get(userSyncKey);
          if (alreadySynced) return;
          await redis.set(userSyncKey, "1", "EX", 300); // 5 min
          await db
            .insertInto("users")
            .values({ id: userId, name: userName, username: userUsername })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({ name: userName, username: userUsername }),
            )
            .execute();
        } catch {}
      })();
    }

    if (chat && chat.type !== "channel") {
      const chatId = chat.id.toString();
      const chatName =
        chat.type === "private"
          ? user
            ? user!.first_name + (user!.last_name ? " " + user!.last_name : "")
            : null
          : chat.title;
      const chatUsername = chat.username || null;

      // Throttle: only sync chat to DB once per 5 minutes
      const chatSyncKey = `chatsync:${chatId}`;
      (async () => {
        try {
          const alreadySynced = await redis.get(chatSyncKey);
          if (alreadySynced) return;
          await redis.set(chatSyncKey, "1", "EX", 300); // 5 min
          await db
            .insertInto("broadcastChats")
            .values({ id: chatId, name: chatName, username: chatUsername })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({ name: chatName, username: chatUsername }),
            )
            .execute();
        } catch {}
      })();

      // userChats registry — only sync once per 10 minutes per user+chat pair
      if (
        user &&
        !user.is_bot &&
        (chat.type === "group" || chat.type === "supergroup")
      ) {
        const ucSyncKey = `ucsync:${user.id}:${chatId}`;
        const nowIso = new Date().toISOString();
        (async () => {
          try {
            const alreadySynced = await redis.get(ucSyncKey);
            if (alreadySynced) return;
            await redis.set(ucSyncKey, "1", "EX", 600); // 10 min
            await db
              .insertInto("userChats")
              .values({
                userId: user!.id.toString(),
                chatId,
                chatTitle: chat.title ?? null,
                firstSeenAt: nowIso,
                lastSeenAt: nowIso,
              })
              .onConflict((oc) =>
                oc
                  .columns(["userId", "chatId"])
                  .doUpdateSet({ chatTitle: chat.title ?? null, lastSeenAt: nowIso }),
              )
              .execute();
          } catch {}
        })();
      }
    }
  } catch {
    // Non-critical — ignore sync errors
  }

  return next();
});

export const userAndChatSyncHandler = composer;
