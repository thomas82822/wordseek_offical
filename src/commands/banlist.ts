/**
 * /banlist  — Show all banned + frozen users (owner/admin only)
 *
 * Displays two sections:
 *   🚫 Banned Users  — users blocked from playing WordSeek
 *   🧊 Frozen Users  — users temporarily frozen (cannot join new games)
 *
 * Usage: /banlist
 * Admin / Owner only. Works in DM or group.
 */

import { Composer } from "grammy";

import { db } from "../config/db";
import { env } from "../config/env";
import { pe } from "../config/constants";
import { isBotAdmin } from "../util/guards";

const composer = new Composer();

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-IN", {
      timeZone: env.TIME_ZONE || "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(d);
  }
}

composer.command("banlist", async (ctx) => {
  if (!ctx.from) return;

  const isOwner = env.ADMIN_USERS.includes(ctx.from.id);
  const isAdmin = isOwner || (await isBotAdmin(ctx.from.id.toString()));
  if (!isAdmin) return;

  const loadingMsg = await ctx.reply(
    `${pe("⏳")} <b>Fetching banned & frozen users...</b>`,
    { parse_mode: "HTML" },
  );

  try {
    // ── Fetch banned users with their profile info ────────────────────────
    const bannedRows = await db
      .selectFrom("bannedUsers as b")
      .leftJoin("users as u", "u.id", "b.userId")
      .select([
        "b.userId",
        "b.createdAt",
        "u.name",
        "u.username",
      ])
      .orderBy("b.createdAt", "desc")
      .execute();

    // ── Fetch frozen users with their profile info ────────────────────────
    const frozenRows = await db
      .selectFrom("frozenUsers as f")
      .leftJoin("users as u", "u.id", "f.userId")
      .select([
        "f.userId",
        "f.createdAt",
        "u.name",
        "u.username",
      ])
      .orderBy("f.createdAt", "desc")
      .execute();

    // ── Build banned section ──────────────────────────────────────────────
    let bannedSection = `${pe("🚫")} <b>Banned Users</b> — <code>${bannedRows.length}</code>\n`;
    if (bannedRows.length === 0) {
      bannedSection += `<i>  No banned users.</i>\n`;
    } else {
      for (const row of bannedRows) {
        const nameStr = row.name ? escHtml(row.name) : `<i>Unknown</i>`;
        const userStr = row.username ? ` (@${escHtml(row.username)})` : "";
        bannedSection +=
          `\n  ${pe("👤")} <a href="tg://user?id=${row.userId}">${nameStr}</a>${userStr}\n` +
          `       ${pe("🆔")} <code>${row.userId}</code>  •  ${pe("📅")} ${fmtDate(row.createdAt)}\n`;
      }
    }

    // ── Build frozen section ──────────────────────────────────────────────
    let frozenSection = `\n${pe("🧊")} <b>Frozen Users</b> — <code>${frozenRows.length}</code>\n`;
    if (frozenRows.length === 0) {
      frozenSection += `<i>  No frozen users.</i>\n`;
    } else {
      for (const row of frozenRows) {
        const nameStr = row.name ? escHtml(row.name) : `<i>Unknown</i>`;
        const userStr = row.username ? ` (@${escHtml(row.username)})` : "";
        frozenSection +=
          `\n  ${pe("👤")} <a href="tg://user?id=${row.userId}">${nameStr}</a>${userStr}\n` +
          `       ${pe("🆔")} <code>${row.userId}</code>  •  ${pe("📅")} ${fmtDate(row.createdAt)}\n`;
      }
    }

    const totalLine =
      `\n<blockquote>${pe("📊")} Total: ` +
      `<b>${bannedRows.length}</b> banned, ` +
      `<b>${frozenRows.length}</b> frozen</blockquote>`;

    const reply =
      `<b>WordSeek — User Restriction List</b>\n\n` +
      `<blockquote>${bannedSection}</blockquote>` +
      `<blockquote>${frozenSection}</blockquote>` +
      totalLine;

    await ctx.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      reply,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.api.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      `${pe("❌")} <b>Error fetching banlist:</b> ${String(err)}`,
      { parse_mode: "HTML" },
    );
  }
});

export const banlistCommand = composer;
