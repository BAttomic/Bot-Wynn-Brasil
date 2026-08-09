import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank } from './guildData.js';
import { inactivityStatus } from './inactivityCheck.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';

// Cruza os membros da guilda (API) com os vínculos no banco (o "registro").
//
// Dois eixos definem os quatro grupos: tem registro (vínculo) ou não × é
// Recruiter (rank acima de Recruit) ou é Recruit. A regra: quem está no Discord
// pode ser Recruiter; quem não está deve ser Recruit.
//
// O relatório fecha com a lista de kick por inatividade: quem estourou a margem
// E já teve a chance de responder ao check-in por DM (ver inactivityCheck.js).
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

  const guildDiscordId = optional('DISCORD_GUILD_ID');
  let inactivity = { kick: [], waiting: [] };
  if (guildDiscordId) {
    const { params } = await getConfig(guildDiscordId);
    const stats = await collections
      .guildStats()
      .find({}, { projection: { uuid: 1, points: 1 } })
      .toArray();
    const checks = await collections.inactivityChecks().find({}).toArray();
    inactivity = inactivityStatus(
      res.members,
      new Map(stats.map((s) => [s.uuid, s.points ?? 0])),
      params,
      checks,
    );
  }

  return {
    verified,
    missingRecruiter,
    shouldBeRecruit,
    recruitNoLink,
    inactivity,
    total: res.members.length,
  };
}

/** Limite de um campo de embed. */
const FIELD_LIMIT = 1024;

/** Teto de caracteres do embed INTEIRO (título + rodapé + todos os campos). */
const EMBED_LIMIT = 6000;

function block(list, max) {
  const s = list.join(', ');
  if (!s) return 'Nenhum';
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

// Título curto + explicação numa linha de citação (>) acima dos nicks.
//
// O orçamento desconta a linha de descrição: `> ${desc}\n` + 1000 de nicks
// passava dos 1024 do campo, e o Discord recusa o embed inteiro por isso.
function field(name, desc, list) {
  const cabecalho = `> ${desc}\n`;
  return {
    name: `${name} (${list.length})`,
    value: `${cabecalho}${block(list, FIELD_LIMIT - cabecalho.length - 2)}`,
  };
}

/** Espaço guardado para o rodapé "… e mais N." quando a lista não cabe. */
const RESTO_RESERVA = 32;

/**
 * Um `/gu kick <nick>` por linha, dentro de um bloco de código: dá para copiar a
 * lista inteira e colar no jogo sem catar nick a nick. Corta pelo fim se a lista
 * não couber no campo, avisando quantos ficaram de fora.
 * @param {Array<{username: string}>} kick
 * @param {number} usado  caracteres já gastos pelo resto do campo
 * @returns {string}
 */
function kickBlock(kick, usado) {
  const CERCA = 8; // ```\n … ```
  const linhas = [];
  let len = usado + CERCA + RESTO_RESERVA;

  for (const k of kick) {
    const linha = `/gu kick ${k.username}\n`;
    if (len + linha.length > FIELD_LIMIT) break;
    linhas.push(linha);
    len += linha.length;
  }

  const resto = kick.length - linhas.length;
  return `\`\`\`\n${linhas.join('')}\`\`\`${resto > 0 ? `\n-# … e mais ${resto}.` : ''}`;
}

/**
 * "2 não responderam · 1 sem interesse" — o porquê de cada nick estar na lista,
 * fora do bloco de código para não sujar o copiar-e-colar.
 * @param {Array<{reason: string}>} kick
 */
function reasonSummary(kick) {
  const contagem = new Map();
  for (const k of kick) contagem.set(k.reason, (contagem.get(k.reason) ?? 0) + 1);
  return [...contagem].map(([motivo, n]) => `${n} ${motivo}`).join(' · ');
}

/** @param {{kick: Array<object>, waiting: Array<object>}} inactivity */
function inactivityFields(inactivity) {
  const { kick, waiting } = inactivity;
  const fields = [];

  const resumo = kick.length
    ? `> Estouraram a margem e já tiveram a chance de responder — ${reasonSummary(kick)}.\n`
    : '';
  fields.push({
    name: `🥾 Liberar slot por inatividade (${kick.length})`,
    value: kick.length
      ? `${resumo}${kickBlock(kick, resumo.length)}`
      : '> Ninguém para expulsar por inatividade agora. 🎉',
  });

  if (waiting.length) {
    const desc = '> Receberam a DM do check-in e ainda têm prazo correndo. Não expulse.\n';
    const linhas = [];
    let len = desc.length;
    for (const w of waiting) {
      const linha = `\`${w.username}\` — ${w.offline}d offline · ${w.note} <t:${Math.floor(w.deadline / 1000)}:R>`;
      if (len + linha.length + RESTO_RESERVA > FIELD_LIMIT) break;
      linhas.push(linha);
      len += linha.length + 1;
    }
    const resto = waiting.length - linhas.length;
    fields.push({
      name: `⏳ Perguntamos, aguardando resposta (${waiting.length})`,
      value: `${desc}${linhas.join('\n')}${resto > 0 ? `\n-# … e mais ${resto}.` : ''}`,
    });
  }

  return fields;
}

/**
 * O Discord recusa o embed INTEIRO se a soma passar de 6000 caracteres — com uma
 * guilda cheia, os quatro campos de listagem mais as duas listas de inatividade
 * chegam perto. Quando aperta, encurtamos as LISTAGENS (informativas) e
 * preservamos a lista de kick, que é o que a staff executa.
 * @param {{title?: string, footer?: {text: string}, fields: Array<{name: string, value: string}>}} embed
 */
function fitEmbed(embed) {
  const size = () =>
    (embed.title?.length ?? 0) +
    (embed.footer?.text?.length ?? 0) +
    embed.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);

  // `slice` copia o array antes de ordenar: a ordem dos campos no embed não
  // muda, só a ordem em que eles são encurtados (do maior para o menor).
  for (const f of embed.fields.slice(0, 4).sort((a, b) => b.value.length - a.value.length)) {
    const excesso = size() - EMBED_LIMIT;
    if (excesso <= 0) break;
    const corte = Math.min(excesso + 2, Math.max(0, f.value.length - 60));
    if (corte > 0) f.value = `${f.value.slice(0, f.value.length - corte)} …`;
  }
  return embed;
}

export function verificationEmbed(data) {
  return fitEmbed({
    title: 'Wynn Brasil [WnBR] — Verificação',
    color: 0x3498db,
    fields: [
      field('🔰 Membros verificados', 'Na guilda, Recruiter e com registro.', data.verified),
      field('⬆️ No Discord', 'Na guilda e com registro — falta virar Recruiter.', data.missingRecruiter),
      field('⬇️ Na guilda', 'Recruiter sem registro — deveria ser Recruit.', data.shouldBeRecruit),
      field('🤙 Sem vínculo no Discord', 'Recruit sem registro — tá certo.', data.recruitNoLink),
      ...inactivityFields(data.inactivity ?? { kick: [], waiting: [] }),
    ],
    footer: { text: 'Quem tem registro pode ser Recruiter; quem não tem deve ser Recruit. Ranks do jogo são manuais — o bot só avisa. Use /reconciliar para auditar cargos.' },
    timestamp: new Date().toISOString(),
  });
}
