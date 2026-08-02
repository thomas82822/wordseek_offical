import { Composer } from "grammy";

import { idCommand } from "./id";
import { helpCommand } from "./help";
import { scoreCommand } from "./score";
import { startCommand } from "./start";
import { statsCommand } from "./stats";
import { trackCommand } from "./track";
import { banCommand } from "./ban-user";
import { captchaCommand } from "./captcha";
import { endGameCommand } from "./end-game";
import { myScoreCommand } from "./my-score";
import { newGameCommand } from "./new-game";
import { unbanCommand } from "./unban-user";
// wban/wunban are defined in the same files as ban/unban — already exported via those composers
import { dailyWordleCommand } from "./daily";
import { seekAuthCommand } from "./seekauth";
import { transferCommand } from "./transfer";
import { broadcastCommand } from "./broadcast";
import { startMatchCommand } from "./startmatch";
import { leaderboardCommand } from "./leaderboard";
import { allowOnlyLenCommand } from "./allowonlylen";
import { setGameTopicCommand } from "./setgametopic";
import { recreateTopicCommand } from "./recreatetopic";
import { unsetGameTopicCommand } from "./unsetgametopic";
import { giveAdminCommand } from "./giveadmin";
import { addScoreCommand } from "./addscore";
import { rmScoreCommand } from "./rmscore";
import { requestTransferCommand } from "./requesttransfer";
import { unfreezeCommand } from "./unfreeze";
import { claimBonusCommand } from "./claimbonus";
import { hourlyPromoCommand } from "./hourlypromo";
import { setStartCommand } from "./setstart";
import { downloadDataCommand } from "./download-data";
import { setTitleCommand } from "./settitle";
import { botModeCommand } from "./botmode";
import { dailyRewardCommand } from "./daily-reward";
import { requestTitleCommand } from "./requesttitle";
import { userDetailsCommand } from "./userdetails";
import { banlistCommand } from "./banlist";

const composer = new Composer();

composer.use(
  startCommand,
  helpCommand,
  newGameCommand,
  endGameCommand,
  myScoreCommand,
  statsCommand,
  banCommand,
  unbanCommand,
  leaderboardCommand,
  scoreCommand,
  seekAuthCommand,
  startMatchCommand,
  setGameTopicCommand,
  unsetGameTopicCommand,
  trackCommand,
  transferCommand,
  requestTransferCommand,
  broadcastCommand,
  dailyWordleCommand,
  idCommand,
  allowOnlyLenCommand,
  recreateTopicCommand,
  captchaCommand,
  giveAdminCommand,
  addScoreCommand,
  rmScoreCommand,
  unfreezeCommand,
  claimBonusCommand,
  hourlyPromoCommand,
  setStartCommand,
  downloadDataCommand,
  setTitleCommand,
  botModeCommand,
  dailyRewardCommand,
  requestTitleCommand,
  userDetailsCommand,
  banlistCommand,
);

export const commands = composer;
