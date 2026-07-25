/**
 * Tolerância de inatividade proporcional à contribuição.
 *
 * Todo membro tem um limite base (7 dias). Quem contribuiu mais ganha dias de
 * perdão: a cada `inactivityForgivenessPerPoints` pontos, +1 dia, até um teto.
 *
 * A diferença para a regra antiga, que só olhava Guild XP, é que agora guerras,
 * guild raids e objetivos semanais também compram margem — quem defende
 * território ganha tolerância tanto quanto quem farma.
 */

const DAY_MS = 86_400_000;

/**
 * Dias de perdão que a pontuação compra.
 * @param {number} points
 * @param {import('../config/guildConfig.js').GuildParams} params
 * @returns {number} dias inteiros, nunca acima do teto
 */
export function forgivenessDays(points, params) {
  const per = Number(params?.inactivityForgivenessPerPoints) || 0;
  const max = Number(params?.inactivityForgivenessMaxDays) || 0;
  if (per <= 0 || max <= 0) return 0;
  const earned = Math.floor((Number(points) || 0) / per);
  return Math.max(0, Math.min(max, earned));
}

/**
 * Limite total de dias offline antes de o membro poder ser expulso.
 * @param {number} points
 * @param {import('../config/guildConfig.js').GuildParams} params
 * @returns {number}
 */
export function allowanceDays(points, params) {
  const base = Number(params?.inactivityDays) || 0;
  return base + forgivenessDays(points, params);
}

/**
 * Dias inteiros desde o último login. `null` se a API não sabe.
 * @param {Date|string|null} lastJoin
 * @returns {number|null}
 */
export function daysOffline(lastJoin) {
  if (!lastJoin) return null;
  return Math.floor((Date.now() - new Date(lastJoin).getTime()) / DAY_MS);
}

/**
 * Avalia um membro da guilda contra o próprio limite.
 * @param {{username: string, lastJoin: Date|null, online: boolean}} member
 * @param {number} points
 * @param {import('../config/guildConfig.js').GuildParams} params
 * @returns {{username: string, points: number, offline: number|null, allowance: number, forgiveness: number, kickable: boolean}}
 */
export function evaluate(member, points, params) {
  const offline = daysOffline(member.lastJoin);
  const forgiveness = forgivenessDays(points, params);
  const allowance = allowanceDays(points, params);
  return {
    username: member.username,
    points,
    offline,
    allowance,
    forgiveness,
    kickable: !member.online && offline !== null && offline >= allowance,
  };
}

/**
 * Quem já pode ser expulso, do mais inativo para o menos.
 * @param {Array<object>} members         membros vindos de fetchGuildMembers
 * @param {Map<string, number>} pointsByUuid
 * @param {import('../config/guildConfig.js').GuildParams} params
 */
export function listKickable(members, pointsByUuid, params) {
  return members
    .map((m) => evaluate(m, pointsByUuid.get(m.uuid) ?? 0, params))
    .filter((r) => r.kickable)
    .sort((a, b) => b.offline - a.offline);
}
