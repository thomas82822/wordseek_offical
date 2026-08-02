import { BotError, Context, GrammyError } from "grammy";

import { db } from "../config/db";
import { redis } from "../config/redis";

export async function errorHandler(error: BotError<Context>) {
  const ctx = error.ctx;
  const e = error.error;

  if (e instanceof GrammyError) {
    conditions: if (
      e.description.includes(
        "not enough rights to send text messages to the chat",
      ) &&
      ctx.chat?.type !== "private"
    ) {
      try {
        if (ctx.chat) await ctx.api.leaveChat(ctx.chat.id);
      } catch {
        // Could not leave chat — ignore
      }
    } else if (
      e.description.includes("message thread not found") &&
      ctx.chatId &&
      ctx.msg
    ) {
      const topicsData = await db
        .selectFrom("chatGameTopics")
        .selectAll()
        .where("chatId", "=", ctx.chatId.toString())
        .execute();
      const currentTopicId = ctx.msg.message_thread_id?.toString();
      if (!currentTopicId) break conditions;

      const topic = topicsData.find((t) => t.topicId === currentTopicId);
      if (!topic || !topic.shouldRecreateOnExpire) break conditions;

      const message = await ctx.api.sendMessage(ctx.chatId, "Recreating topic...");
      try {
        const createdTopic = await ctx.createForumTopic(topic.name || "Wordseek", {
          icon_custom_emoji_id: topic.iconCustomEmojiId ?? undefined,
        });
        await ctx.deleteForumTopic();
        await ctx.api.deleteMessage(ctx.chatId, message.message_id);
        await db
          .insertInto("chatGameTopics")
          .values({
            chatId: ctx.chatId.toString(),
            topicId: createdTopic.message_thread_id.toString(),
            iconCustomEmojiId: createdTopic.icon_custom_emoji_id,
            shouldRecreateOnExpire: true,
            allowedLengths: topic.allowedLengths,
            name: topic.name,
          })
          .execute();
        await db
          .deleteFrom("chatGameTopics")
          .where("chatId", "=", ctx.chatId.toString())
          .where("topicId", "=", currentTopicId)
          .execute();
        await redis.del(`vote:${ctx.chatId}`);
        await ctx.api.sendMessage(
          ctx.chatId,
          "Topic recreated successfully. You can now continue playing in this topic.",
          { reply_parameters: { message_id: createdTopic.message_thread_id } },
        );
      } catch {
        await ctx.api.editMessageText(
          ctx.chatId,
          message.message_id,
          "I don't have enough rights to create and delete topics. Please update my permissions.",
        );
      }
    }
  }
  // All other errors are silently ignored to prevent bot crashes
}
