import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank } from './guildData.js';
import { optional } from '../config/env.js';

// Cruza os membros da guilda (API) com os vínculos no banco (o "registro").
//
// Dois eixos definem os quatro grupos: tem registro (vínculo) ou não × é
// Recruiter (rank acima de Recruit) ou é Recruit. A regra: quem está no Discord
// pode ser Recruiter; quem não está deve ser Recruit.
export async function computeVerification() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;
  const res = await fetchGuildMembers(prefix);
  if (!res) return null;

  const linkByUuid = new Map((await collections.members().find({}).toArray()).map((m) => [m.uuid, m]));

  // Nick entre crases: nome com `_` não vira itálico/negrito no Discord.
  const nick = (u) => `\`${u}\``;

  const verified = []; // registro + na guilda + Recruiter → tudo certo
  const missingRecruiter = []; // registro + na guilda + ainda Recruit → falta promover
  const shouldBeRecruit = []; // sem registro + na guilda + Recruiter → deveria ser Recruit
  const recruitNoLink = []; // sem registro + na guilda + Recruit → certo

  for (const gm of res.members) {
    const link = linkByUuid.get(gm.uuid);
    if (link?.classification === 'banned') continue; // banido não entra no relatório
    const registered = !!link;
    const isRecruiter = isHigherRank(gm.rank, 'recruit'); // qualquer rank acima de Recruit

    if (registered) (isRecruiter ? verified : missingRecruiter).push(nick(gm.username));
    else (isRecruiter ? shouldBeRecruit : recruitNoLink).push(nick(gm.username));
  }

  return { verified, missingRecruiter, shouldBeRecruit, recruitNoLink, total: res.members.length };
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
      { name: `🔰 Membros verificados — na guilda, Recruiter, com registro (${data.verified.length})`, value: block(data.verified) },
      { name: `⬆️ No Discord — na guilda e com registro, falta virar Recruiter (${data.missingRecruiter.length})`, value: block(data.missingRecruiter) },
      { name: `⬇️ Na guilda — Recruiter sem registro, deveria ser Recruit (${data.shouldBeRecruit.length})`, value: block(data.shouldBeRecruit) },
      { name: `🤙 Na guilda sem vínculo no Discord — Recruit (tá certo) (${data.recruitNoLink.length})`, value: block(data.recruitNoLink) },
    ],
    footer: { text: 'Quem está no Discord (tem registro) pode ser Recruiter; quem não está deve ser Recruit. Ranks do jogo são manuais — o bot só avisa. Use /reconciliar para auditar cargos.' },
    timestamp: new Date().toISOString(),
  };
}
