import { InlineKeyboard } from "grammy";

interface UserEntry {
  id: string;
  name: string;
  username: string | null;
}

export function generateUserSelectionKeyboard(users: UserEntry[], username: string): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const user of users) {
    const label = user.username
      ? `${user.name} (@${user.username}) [${user.id}]`
      : `${user.name} [${user.id}]`;
    kb.text(label, `score_select ${user.id} ${username}`).row();
  }

  return kb;
}
