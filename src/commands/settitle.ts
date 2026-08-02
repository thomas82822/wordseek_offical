/**
 * /settitle list                    — Show all current title tiers
 * /settitle set <threshold> <name>  — Add or update a title tier
 * /settitle remove <threshold>      — Remove a title tier
 * /settitle reset                   — Reset to default titles
 *
 * Owner only.
 */

import { Composer } from "grammy";

import { env } from "../config/env";
import { pe } from "../config/constants";
import { CommandsHelper } from "../util/commands-helper";
import { DEFAULT_TITLES, loadTitles, saveTitles } from "../config/title-config";

const composer = new Composer();

composer.command("settitle", async (ctx) => {
  if (!ctx.from) return;
  if (!env.ADMIN_USERS.includes(ctx.from.id)) return;

  const args = ctx.match.trim().split(/\s+/);
  const subCmd = args[0]?.toLowerCase();

  // ── List ─────────────────────────────────────────────────────────────────
  if (!subCmd || subCmd === "list") {
    const titles = loadTitles();
    if (titles.length === 0) {
      return ctx.reply(`${pe("📋")} No title tiers configured.`, {
        parse_mode: "HTML",
      });
    }
    const lines = titles.map(
      (t) =>
        `• <code>${t.threshold.toLocaleString()}</code> pts → <b>${t.name}</b>`,
    );
    return ctx.reply(
      `${pe("👑")} <b>Title Tiers</b>\n\n` +
        `<blockquote>${lines.join("\n")}</blockquote>\n\n` +
        `<i>Commands:\n` +
        `/settitle set &lt;pts&gt; &lt;name&gt;\n` +
        `/settitle remove &lt;pts&gt;\n` +
        `/settitle reset</i>`,
      { parse_mode: "HTML" },
    );
  }

  // ── Set / update ─────────────────────────────────────────────────────────
  if (subCmd === "set") {
    const threshold = parseInt(args[1] ?? "");
    const name = args.slice(2).join(" ").trim();

    if (isNaN(threshold) || threshold <= 0) {
      return ctx.reply(
        `${pe("❌")} Usage: <code>/settitle set &lt;pts&gt; &lt;name&gt;</code>\n` +
          `Example: <code>/settitle set 5000 Word Artisan</code>`,
        { parse_mode: "HTML" },
      );
    }
    if (!name) {
      return ctx.reply(`${pe("❌")} Please provide a title name after the threshold.`, {
        parse_mode: "HTML",
      });
    }

    const titles = loadTitles();
    const idx = titles.findIndex((t) => t.threshold === threshold);
    if (idx >= 0) {
      titles[idx].name = name;
    } else {
      titles.push({ threshold, name });
    }
    saveTitles(titles);

    return ctx.reply(
      `${pe("✅")} <b>Title Updated</b>\n\n` +
        `<blockquote><code>${threshold.toLocaleString()}</code> pts → <b>${name}</b></blockquote>`,
      { parse_mode: "HTML" },
    );
  }

  // ── Remove ────────────────────────────────────────────────────────────────
  if (subCmd === "remove") {
    const threshold = parseInt(args[1] ?? "");
    if (isNaN(threshold)) {
      return ctx.reply(
        `${pe("❌")} Usage: <code>/settitle remove &lt;pts&gt;</code>`,
        { parse_mode: "HTML" },
      );
    }

    const titles = loadTitles();
    const filtered = titles.filter((t) => t.threshold !== threshold);
    if (filtered.length === titles.length) {
      return ctx.reply(
        `${pe("⚠️")} No title found at <code>${threshold.toLocaleString()}</code> pts.`,
        { parse_mode: "HTML" },
      );
    }
    saveTitles(filtered);
    return ctx.reply(
      `${pe("✅")} Removed title tier at <code>${threshold.toLocaleString()}</code> pts.`,
      { parse_mode: "HTML" },
    );
  }

  // ── Reset ─────────────────────────────────────────────────────────────────
  if (subCmd === "reset") {
    saveTitles(DEFAULT_TITLES);
    return ctx.reply(`${pe("✅")} <b>Titles reset to defaults.</b>`, {
      parse_mode: "HTML",
    });
  }

  return ctx.reply(
    `${pe("📋")} <b>Title Commands</b>\n\n` +
      `<blockquote>/settitle list — View all tiers\n` +
      `/settitle set &lt;pts&gt; &lt;name&gt; — Add/update tier\n` +
      `/settitle remove &lt;pts&gt; — Remove tier\n` +
      `/settitle reset — Reset to defaults</blockquote>`,
    { parse_mode: "HTML" },
  );
});

CommandsHelper.addNewCommand("settitle", "Manage score title tiers (owner only)", true);

export const setTitleCommand = composer;
