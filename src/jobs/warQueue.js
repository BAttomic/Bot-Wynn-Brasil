import { getConfig } from '../config/guildConfig.js';
import { audit } from '../services/audit.js';
import {
  checkWarEligibility,
  grantWarRole,
  dequeueWar,
  warQueueEntries,
} from '../services/warRole.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

/**
 * Fila do cargo WAR: quem aplicou antes de completar o tempo mínimo de guilda
 * espera aqui e recebe o cargo sozinho assim que cumpre. Ninguém precisa
 * reaplicar, e a staff não precisa lembrar de ninguém.
 *
 * @param {import('discord.js').Client} client
 */
export async function runWarQueue(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const pending = await warQueueEntries(guildDiscordId);
  if (!pending.length) return;

  const cfg = await getConfig(guildDiscordId);
  const roleId = cfg.roles?.war;
  // Sem cargo configurado a fila fica intacta: quando a staff rodar
  // `/config role war`, todo mundo que já esperava é atendido no ciclo seguinte.
  if (!roleId) return;

  const guild = await client.guilds.fetch(guildDiscordId).catch(() => null);
  if (!guild) return;

  let granted = 0;
  for (const entry of pending) {
    const member = await guild.members.fetch(entry.discordId).catch(() => null);
    // Saiu do servidor: não há cargo para dar. Se voltar, aplica de novo.
    if (!member) {
      await dequeueWar(entry.discordId);
      continue;
    }
    // A staff pode ter dado o cargo à mão enquanto a pessoa esperava.
    if (member.roles.cache.has(roleId)) {
      await dequeueWar(entry.discordId);
      continue;
    }

    const { state, days, min } = await checkWarEligibility(guildDiscordId, entry.discordId);
    // Perdeu o vínculo ou foi banido: a espera não faz mais sentido.
    if (state === 'unlinked' || state === 'banned') {
      await dequeueWar(entry.discordId);
      continue;
    }
    // Ainda fora da guilda ou sem os dias: segue esperando, sem avisar nada.
    if (state !== 'ok') continue;

    // Falha do Discord (hierarquia/permissão) não tira ninguém da fila — a
    // próxima varredura tenta de novo.
    if (!(await grantWarRole(member, cfg))) {
      log.warn(`Fila WAR: não consegui aplicar o cargo em ${entry.username} (${entry.discordId}).`);
      continue;
    }

    await dequeueWar(entry.discordId);
    granted += 1;
    await member
      .send(
        `:crossed_swords: Você completou **${min} dias** na **Wynn Brasil** e acabou de receber o cargo de guerra! Fique de olho nas convocações.`,
      )
      .catch(() => {});
    await audit(
      client,
      guildDiscordId,
      `:crossed_swords: <@${entry.discordId}> (**${entry.username}**) completou **${days} dia(s)** de guilda e recebeu <@&${roleId}> automaticamente.`,
    );
  }

  if (granted) log.info(`Fila WAR: ${granted} cargo(s) concedido(s).`);
}
