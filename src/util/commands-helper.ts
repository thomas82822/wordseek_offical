import { bot } from "../config/bot";
import { env } from "../config/env";

type Command = {
  command: string;
  description: string;
};

export class CommandsHelper {
  // Public commands — shown to all users in Telegram's "/" autocomplete
  static commands: Array<Command> = [];

  // ALL commands including admin/owner-only — shown only to admins/owners
  static allCommands: Array<Command> = [];

  /**
   * Register a bot command.
   * @param command     The command name (without /)
   * @param description Short description shown in Telegram
   * @param ownerOnly   If true, hidden from public menu but shown to admins/owners.
   */
  static addNewCommand(command: string, description: string, ownerOnly = false) {
    // Always track in allCommands (for admin scope)
    this.allCommands.push({ command, description });
    // Only add to public list if not owner/admin-only
    if (!ownerOnly) {
      this.commands.push({ command, description });
    }
  }

  static async setCommands() {
    // Set public commands for all users (default scope)
    await bot.api.setMyCommands(this.commands);

    // Set full command list for each admin/owner in their private chat with the bot
    // This makes admin commands appear in "/" autocomplete for admins only
    if (env.ADMIN_USERS.length > 0) {
      const adminSetPromises = env.ADMIN_USERS.map((adminId) =>
        bot.api
          .setMyCommands(this.allCommands, {
            scope: { type: "chat", chat_id: adminId },
          })
          .catch(() => {}), // silently skip if admin hasn't started bot DM yet
      );
      await Promise.all(adminSetPromises);
    }
  }
}
