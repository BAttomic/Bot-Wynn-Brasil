import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from './guildData.js';
import { optional } from '../config/env.js';

// Cruza os membros da guilda (API) com os vínculos no banco.
export async function computeVerification() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;
  const res = await fetchGuildMembers(prefix);
  if (!res) return null;

  const guildUuids = new Set(res.members.map((m) => m.uuid));
  const linked = await collections.members().find({}).toArray();
  const linkedUuids = new Set(linked.map((m) => m.uuid));

  const verified = []; // vinculado e na guilda
  const community = []; // vinculado, fora da guilda — estado LEGÍTIMO (só comunidade)
  const banned = []; // vinculado e marcado como banido
  for (const m of linked) {
    if (m.classification === 'banned') banned.push(m.username);
    else if (guildUuids.has(m.uuid)) verified.push(m.username);
    else community.push(m.username);
  }
  const notLinked = []; // na guilda mas sem vínculo no Discord
  for (const gm of res.members) {
    if (!linkedUuids.has(gm.uuid)) notLinked.push(gm.username);
  }
  return { verified, community, banned, notLinked, total: res.members.length };
}

function block(list, max = 1000) {
  const s = list.join(', ');
  if (!s) return 'Nenhum';
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

export function verificationEmbed(data) {
  return {
    title: 'Wynn Brasil [WnBR] — Verificação',
    color: 0x3498db,
    fields: [
      { name: `🔰 Membros verificados (${data.verified.length})`, value: block(data.verified) },
      { name: `⚪ Comunidade — vinculado, fora da guilda (${data.community.length})`, value: block(data.community) },
      { name: `🚫 Banidos vinculados (${data.banned.length})`, value: block(data.banned) },
      { name: `🤙 Na guilda sem vínculo no Discord (${data.notLinked.length})`, value: block(data.notLinked) },
    ],
    footer: { text: 'Estar na comunidade sem guilda é normal. Para auditar cargos errados e quem está na guilda mas fora do Discord, use /reconciliar.' },
    timestamp: new Date().toISOString(),
  };
}
