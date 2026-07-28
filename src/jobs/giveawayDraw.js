import { collections } from '../db/mongo.js';
import { optional } from '../config/env.js';
import { endGiveaway } from '../services/giveaways.js';
import { log } from '../util/log.js';

/**
 * Sorteia os giveaways cujo prazo venceu.
 *
 * Varre por prazo (índice em status+endAt), então um bot que ficou fora do ar
 * apura tudo o que venceu enquanto isso no primeiro ciclo depois de voltar.
 *
 * @param {import('discord.js').Client} client
 */
export async function runGiveawayDraw(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const due = await collections
    .giveaways()
    .find({ guildDiscordId, status: 'active', endAt: { $lte: new Date() } })
    .toArray();
  if (!due.length) return;

  for (const gw of due) await endGiveaway(client, gw);
  log.info(`Sorteios apurados: ${due.length}.`);
}
