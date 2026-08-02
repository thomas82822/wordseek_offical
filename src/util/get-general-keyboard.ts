import { InlineKeyboard } from "grammy";

import { UPDATES_CHANNEL } from "../config/constants";

export function getGeneralKeyboard() {
  return new InlineKeyboard()
    .text("❓ How to Play", "help_howto")
    .url("📢 Updates", UPDATES_CHANNEL);
}
