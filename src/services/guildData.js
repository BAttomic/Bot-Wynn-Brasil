import { wynn } from '../wynn/api.js';

export const RANKS = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];

export const RANK_LABEL = {
  owner: 'Líder',
  chief: 'Sub-líder',
  strategist: 'Estrategista',
  captain: 'Capitão',
  recruiter: 'Recrutador',
  recruit: 'Recruta',
};

// recruit = 1 … owner = 6. Desconhecido/ausente = 0, para comparar sem casos especiais.
export function rankWeight(rank) {
  const i = RANKS.indexOf(rank);
  return i === -1 ? 0 : RANKS.length - i;
}

export function isHigherRank(rank, than) {
  return rankWeight(rank) > rankWeight(than);
}

function total(value) {
  if (value && typeof value === 'object') return Number(value.total ?? 0);
  return Number(value ?? 0);
}

// Busca a guilda e normaliza os membros num array simples.
// Os membros da API v3 vêm indexados por USERNAME e cada um traz globalData
// com wars/raids — então um único request cobre todos os membros.
//
// Cuidado com os dois contadores de raid de guilda: `guildRaids` é o total da
// VIDA do jogador (soma o que ele fez em guildas anteriores), enquanto
// `currentGuildRaids` conta só o que ele fez na guilda atual. Para medir
// contribuição, o segundo é o único que faz sentido.
export async function fetchGuildMembers(prefix) {
  const data = await wynn.guildByPrefix(prefix);
  if (!data || !data.members) return null;

  const members = [];
  for (const rank of RANKS) {
    const group = data.members[rank];
    if (!group) continue;
    for (const [username, m] of Object.entries(group)) {
      const g = m.globalData || {};
      members.push({
        uuid: m.uuid,
        username,
        rank,
        contributed: Number(m.contributed ?? 0),
        contributionRank: Number(m.contributionRank ?? 0),
        wars: Number(g.wars ?? 0),
        raids: total(g.raids),
        guildRaids: total(g.currentGuildRaids),
        // Só vem preenchido em requisição AUTENTICADA e apenas para a guilda
        // dona da WYNN_API_KEY. Sem chave, `weekly` é {} para todo mundo.
        weeklyCompleted: m.weekly?.completed ?? null,
        weeklyStreak: Number(m.weekly?.streak ?? 0),
        joined: m.joined ? new Date(m.joined) : null,
        lastJoin: m.lastJoin ? new Date(m.lastJoin) : null,
        online: !!m.online,
      });
    }
  }
  return { guild: data, members };
}
