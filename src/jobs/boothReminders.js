import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import boothCommand from '../discord/commands/booth.js';
import { log } from '../util/log.js';

const DAY_MS = 86_400_000;
/** Antecedência do aviso: 5 min antes do reset. */
const LEAD_MS = 5 * 60_000;

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

/**
 * Avisa os donos ~5 min antes do reset (24h) do booth e, passado o reset, rola o
 * ciclo para as próximas 24h — repetindo indefinidamente até o dono parar (botão
 * "Parar avisos" ou /booth cancelar).
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function runBoothReminders(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.booth;
  if (!channelId) return; // sem canal, não há como avisar
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const booths = collections.booths();
  const now = new Date();

  // Só quem já entrou na janela: precisa notificar (≤5 min p/ resetar) ou já
  // passou do reset (rolar o ciclo).
  const due = await booths.find({ nextResetAt: { $lte: new Date(now.getTime() + LEAD_MS) } }).toArray();

  let notified = 0;
  for (const b of due) {
    // Já resetou: avança para o próximo reset (loop cobre downtime do bot) e
    // rearma o aviso do novo ciclo.
    if (now >= new Date(b.nextResetAt)) {
      let next = new Date(b.nextResetAt).getTime();
      while (now.getTime() >= next) next += DAY_MS;
      await booths.updateOne(
        { _id: b._id },
        { $set: { nextResetAt: new Date(next), notifiedForReset: false } },
      );
      continue;
    }

    // Dentro dos 5 min finais e ainda não avisado neste ciclo.
    if (!b.notifiedForReset) {
      await channel.send({
        content:
          `⏰ <@${b.discordId}>, seu **booth** em **${b.location}** reseta <t:${unix(b.nextResetAt)}:R>. ` +
          'Vá re-colocar antes de perder o local!',
        components: [boothCommand.stopButtonRow(b.discordId)],
        allowedMentions: { users: [b.discordId] },
      });
      await booths.updateOne({ _id: b._id }, { $set: { notifiedForReset: true } });
      notified += 1;
    }
  }

  if (notified) log.info(`Lembretes de booth: ${notified} aviso(s) enviado(s).`);
}
