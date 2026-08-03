import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from './guildData.js';
import { optional } from '../config/env.js';

// Cruza os membros da guilda (API) com os vínculos no banco.
export async function computeVerification() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;
  const res = await fetchGuildMembers(prefix);
  if (!res) return null;

  const rankByUuid = new Map(res.members.map((m) => [m.uuid, m.rank]));
  const guildUuids = new Set(res.members.map((m) => m.uuid));
  const linked = await collections.members().find({}).toArray();
  const linkedUuids = new Set(linked.map((m) => m.uuid));

  const verified = []; // vinculado e na guilda
  // No Discord (verificado) → pode ser Recrutador. Ainda como Recruta = elegível a subir.
  const canBeRecruiter = [];
  for (const m of linked) {
    if (m.classification === 'banned') continue; // banido não entra no relatório
    if (guildUuids.has(m.uuid)) {
      verified.push(m.username);
      if (rankByUuid.get(m.uuid) === 'recruit') canBeRecruiter.push(m.username);
    }
    // vinculado fora da guilda (só comunidade) é estado legítimo — não exibimos mais.
  }

  // Na guilda mas sem vínculo no Discord → deveriam ser Recruta.
  // Só o nick, entre crases: nome com `_` não vira itálico/negrito no Discord.
  const notLinked = [];
  for (const gm of res.members) {
    if (linkedUuids.has(gm.uuid)) continue;
    notLinked.push(`\`${gm.username}\``);
  }

  return { verified, notLinked, canBeRecruiter, total: res.members.length };
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
      { name: `⬆️ No Discord — podem virar Recrutador (${data.canBeRecruiter.length})`, value: block(data.canBeRecruiter) },
      { name: `🤙 Na guilda sem vínculo no Discord — deveriam ser Recruta (${data.notLinked.length})`, value: block(data.notLinked) },
    ],
    footer: { text: 'Quem está no Discord pode ser Recrutador; quem não está deve ser Recruta. Ranks do jogo são manuais — o bot só avisa. Use /reconciliar para auditar cargos.' },
    timestamp: new Date().toISOString(),
  };
}
