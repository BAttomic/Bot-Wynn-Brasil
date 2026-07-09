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
  const invalid = []; // vinculado mas fora da guilda
  for (const m of linked) {
    if (guildUuids.has(m.uuid)) verified.push(m.username);
    else invalid.push(m.username);
  }
  const notLinked = []; // na guilda mas sem vínculo no Discord
  for (const gm of res.members) {
    if (!linkedUuids.has(gm.uuid)) notLinked.push(gm.username);
  }
  return { verified, invalid, notLinked, total: res.members.length };
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
      { name: `🔰 Verificados (${data.verified.length})`, value: block(data.verified) },
      { name: `❌ Inválidos — cargo sem estar na guilda (${data.invalid.length})`, value: block(data.invalid) },
      { name: `🤙 Não verificados — na guilda sem vínculo (${data.notLinked.length})`, value: block(data.notLinked) },
    ],
    footer: { text: 'Dados da API Wynncraft' },
    timestamp: new Date().toISOString(),
  };
}
