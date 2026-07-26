import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { guildTenureDays } from './eligibility.js';

/**
 * Cargo WAR (exército geral) é automático: quem aplica recebe na hora, e quem
 * ainda não tem o tempo mínimo de guilda fica na fila `warQueue` até completar —
 * o job `warQueue` concede sozinho, sem reaplicar.
 *
 * MAIN WAR continua sendo decisão da staff: os critérios dele (build dedicada,
 * confiança, mapa liberado) não dá para verificar por API.
 */

/** @param {string} guildDiscordId @returns {Promise<number>} */
export async function warMinGuildDays(guildDiscordId) {
  const { params } = await getConfig(guildDiscordId);
  return Number(params?.warMinGuildDays) || 3;
}

/**
 * @typedef {object} WarEligibility
 * @property {'ok'|'tooNew'|'notMember'|'unlinked'|'banned'} state
 * @property {number|null} days    dias na guilda; null = entrada não confirmada
 * @property {number} min
 * @property {object|null} linked  documento de `members`
 */

/**
 * Só o `unlinked` impede de entrar na fila (sem uuid não há o que acompanhar).
 * `notMember` e `tooNew` esperam: entrar na guilda e completar os dias é
 * exatamente o que o job fica observando.
 *
 * @param {string} guildDiscordId
 * @param {string} discordId
 * @returns {Promise<WarEligibility>}
 */
export async function checkWarEligibility(guildDiscordId, discordId) {
  const min = await warMinGuildDays(guildDiscordId);
  const linked = await collections.members().findOne({ discordId });
  if (!linked) return { state: 'unlinked', days: null, min, linked: null };
  if (linked.classification === 'banned') return { state: 'banned', days: null, min, linked };
  // `guildStats.joinedGuildAt` sobrevive a uma saída da guilda, então o tempo
  // sozinho diria que um ex-membro cumpre o requisito. `inGuild` (mantido pelo
  // roleSync) é quem decide se a pessoa está lá AGORA.
  if (!linked.inGuild) return { state: 'notMember', days: null, min, linked };

  const days = await guildTenureDays(linked.uuid);
  if (days === null || days < min) return { state: 'tooNew', days, min, linked };
  return { state: 'ok', days, min, linked };
}

/**
 * @param {import('discord.js').GuildMember} member
 * @param {import('../config/guildConfig.js').GuildConfig} cfg
 * @returns {Promise<boolean>} false = cargo não configurado, ou o Discord recusou
 *   (cargo acima do do bot / falta de permissão).
 */
export async function grantWarRole(member, cfg) {
  const roleId = cfg.roles?.war;
  if (!roleId || !member?.roles) return false;
  if (member.roles.cache.has(roleId)) return true;
  return member.roles.add(roleId).then(() => true).catch(() => false);
}

/**
 * @param {{guildDiscordId: string, discordId: string, uuid: string, username: string,
 *          application: Record<string, string>}} entry
 */
export function enqueueWar({ guildDiscordId, discordId, uuid, username, application }) {
  return collections.warQueue().updateOne(
    { discordId },
    {
      // Reaplicar atualiza classe/interesse/função sem perder a data de entrada.
      $set: { guildDiscordId, discordId, uuid, username, application, updatedAt: new Date() },
      $setOnInsert: { queuedAt: new Date() },
    },
    { upsert: true },
  );
}

/** @param {string} discordId */
export function dequeueWar(discordId) {
  return collections.warQueue().deleteOne({ discordId });
}

/** @param {string} guildDiscordId */
export function warQueueEntries(guildDiscordId) {
  return collections.warQueue().find({ guildDiscordId }).sort({ queuedAt: 1 }).toArray();
}
