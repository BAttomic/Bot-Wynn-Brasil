import { wynn } from '../wynn/api.js';

export const RANKS = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];

function raidsTotal(globalData) {
  const r = globalData?.raids;
  if (r && typeof r === 'object') return Number(r.total ?? 0);
  return Number(r ?? 0);
}

// Busca a guilda e normaliza os membros num array simples.
// Os membros da API v3 vêm indexados por USERNAME e cada um traz globalData
// com wars/raids — então um único request cobre todos os membros.
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
        wars: Number(g.wars ?? 0),
        raids: raidsTotal(g),
        joined: m.joined ? new Date(m.joined) : null,
        lastJoin: m.lastJoin ? new Date(m.lastJoin) : null,
        online: !!m.online,
      });
    }
  }
  return { guild: data, members };
}
