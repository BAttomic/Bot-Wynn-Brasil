import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { fetchGuildMembers } from './guildData.js';
import { wynn } from '../wynn/api.js';
import { optional } from '../config/env.js';

// Elegibilidade por tempo de guilda, compartilhada por Tomes e Aspects: o jogo
// exige ~1 semana na guilda para receber Tomes, e aplicamos o mesmo aos aspects.

/** Dias inteiros desde uma data; null se não houver data. */
export function daysSince(date) {
  return date ? Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000) : null;
}

export async function minGuildDays(guildId) {
  const { params } = await getConfig(guildId);
  return Number(params?.rewardMinGuildDays) || 7;
}

/**
 * Data de entrada na guilda: primeiro do guildStats (gravado no snapshot a partir
 * do campo `joined` da API), e como fallback ao vivo do roster. É a data REAL de
 * entrada — então o cálculo de dias é sempre correto, mesmo recém-gravado.
 * @returns {Promise<Date|null>}
 */
export async function guildJoinDate(uuid) {
  const s = await collections.guildStats().findOne({ uuid }, { projection: { joinedGuildAt: 1 } });
  if (s?.joinedGuildAt) return s.joinedGuildAt;
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;
  const res = await fetchGuildMembers(prefix).catch(() => null);
  return res?.members.find((m) => m.uuid === uuid)?.joined ?? null;
}

/** Dias na guilda (null = não confirmado na guilda). */
export async function guildTenureDays(uuid) {
  return daysSince(await guildJoinDate(uuid));
}

export async function tomeMinLevel(guildId) {
  const { params } = await getConfig(guildId);
  return Number(params?.tomeMinClassLevel) || 100;
}

/**
 * Maior nível de combate entre as classes do jogador. null se a API não
 * respondeu; 0 se não tem personagem. (Tome exige uma classe neste nível.)
 * @returns {Promise<number|null>}
 */
export async function maxClassLevel(username) {
  const p = await wynn.player(username).catch(() => null);
  if (!p || !p.uuid) return null;
  const chars = p.characters ? Object.values(p.characters) : [];
  return Math.max(0, ...chars.map((c) => Number(c?.level ?? c?.combatLevel) || 0));
}
