import { collections } from '../db/mongo.js';
import { fetchGuildMembers, isHigherRank, rankWeight, RANK_LABEL } from './guildData.js';
import { membersLimit } from '../util/format.js';
import { inactivityStatus, withObservedActivity } from './inactivityCheck.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { queueApplications } from './applications.js';
import { expectedGameRank, missingRequirements } from './promotions.js';

/** Ranks do jogo que um cargo de trilha representa. Recrutador e Recruta não. */
const TRAIL_RANKS = new Set(['captain', 'strategist', 'chief']);

// Cruza os membros da guilda (API) com os vínculos no banco (o "registro").
//
// Dois eixos definem os quatro grupos: tem registro (vínculo) ou não × é
// Recruiter (rank acima de Recruit) ou é Recruit. A regra: quem está no Discord
// pode ser Recruiter; quem não está deve ser Recruit.
//
// Depois vem o RANK NO JOGO contra o cargo de trilha no Discord, nos dois
// sentidos. O cargo (dado pelo bot por guerras e pontos, ou o Chefe à mão) é a
// referência: pede um rank acima do que a pessoa tem no jogo → promover lá; a
// pessoa tem no jogo Capitão para cima sem cargo que o sustente → rebaixar lá
// (para o rank do cargo, ou Recrutador sem cargo nenhum). O bot não mexe no
// jogo; a staff ajusta com esta lista. E, à parte, quem tem cargo de trilha sem
// ter as guerras ou os pontos da meta.
//
// O relatório fecha com a lista de kick por inatividade: quem estourou a margem
// E já teve a chance de responder ao check-in por DM (ver inactivityCheck.js).
//
// @param {import('discord.js').Client} [client]  sem ele, as listas de cargo ficam vazias
export async function computeVerification(client) {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;
  const res = await fetchGuildMembers(prefix);
  if (!res) return null;

  const linkByUuid = new Map((await collections.members().find({}).toArray()).map((m) => [m.uuid, m]));
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const stats = await collections
    .guildStats()
    .find({}, { projection: { uuid: 1, points: 1, guildWars: 1 } })
    .toArray();
  const statsByUuid = new Map(stats.map((s) => [s.uuid, s]));

  // Os cargos vêm do cache de membros. O fetch o completa; se falhar, vale o
  // que o cache já tem (o roleSync o enche a cada ciclo).
  const discordGuild = client && guildDiscordId ? await client.guilds.fetch(guildDiscordId).catch(() => null) : null;
  if (discordGuild) await discordGuild.members.fetch().catch(() => {});

  // Nick entre crases: nome com `_` não vira itálico/negrito no Discord.
  const nick = (u) => `\`${u}\``;

  const verified = []; // registro + na guilda + Recruiter → tudo certo
  const missingRecruiter = []; // registro + na guilda + ainda Recruit → falta promover
  const shouldBeRecruit = []; // sem registro + na guilda + Recruiter → deveria ser Recruit
  const recruitNoLink = []; // sem registro + na guilda + Recruit → certo
  const rankInGame = []; // rank no jogo diferente do que o cargo de trilha pede
  const missingReq = []; // cargo de trilha sem a meta de guerras/pontos

  for (const gm of res.members) {
    const link = linkByUuid.get(gm.uuid);
    if (link?.classification === 'banned') continue; // banido não entra no relatório
    const registered = !!link;
    const isRecruiter = isHigherRank(gm.rank, 'recruit'); // qualquer rank acima de Recruit

    if (registered) (isRecruiter ? verified : missingRecruiter).push(nick(gm.username));
    else (isRecruiter ? shouldBeRecruit : recruitNoLink).push(nick(gm.username));

    // Sem o membro no Discord não há cargo para comparar. Quem não tem vínculo e
    // é Capitão para cima já aparece acima, em "deveria ser Recruit".
    const member = link?.discordId ? discordGuild?.members.cache.get(link.discordId) : null;
    if (!member) continue;

    const esperado = expectedGameRank(member.roles.cache);
    if (esperado && isHigherRank(esperado, gm.rank)) {
      rankInGame.push({ username: gm.username, from: gm.rank, to: esperado, up: true });
    } else if (TRAIL_RANKS.has(gm.rank) && isHigherRank(gm.rank, esperado)) {
      // O Líder (owner) fica de fora: não é rank de trilha.
      rankInGame.push({ username: gm.username, from: gm.rank, to: esperado ?? 'recruiter', up: false });
    }

    const faltas = missingRequirements(member.roles.cache, statsByUuid.get(gm.uuid));
    if (faltas.length) missingReq.push({ username: gm.username, faltas });
  }
  // Promoções antes, e o rank mais alto primeiro: é o ajuste que mais pesa.
  rankInGame.sort(
    (a, b) => Number(b.up) - Number(a.up) || rankWeight(b.to) - rankWeight(a.to) || a.username.localeCompare(b.username),
  );
  missingReq.sort((a, b) => a.username.localeCompare(b.username));

  // FILA DE ENTRADA: aprovados na votação que ainda não entraram no jogo, em
  // ordem de aprovação — que é a ordem em que a staff convida.
  //
  // A consulta mora em services/applications.js porque o painel de CRUD da fila
  // lê a mesma coisa, e duas versões de "fila" divergiriam no primeiro ajuste.
  //
  // O filtro pelo roster fica aqui por cima, como rede: quem entra tem a
  // candidatura fechada pelo roleSync, que roda a cada 10 min, e nessa janela a
  // pessoa já está no jogo sem precisar continuar ocupando a fila.
  const naGuilda = new Set(res.members.map((m) => m.uuid));
  const esperando = (await queueApplications()).filter((a) => !naGuilda.has(a.uuid)).length;

  // Vaga livre + gente esperando = alguém tem de mandar convite. Só o CRUZAMENTO
  // dos dois merece aviso: fila sem vaga é espera legítima, e vaga sem fila não
  // tem o que fazer. O relatório aponta para o canal da fila em vez de repetir a
  // lista — ela já vive lá, e duas cópias divergem no primeiro convite.
  const limite = membersLimit(res.guild?.level);
  const slots = Math.max(0, limite - res.members.length);

  let inactivity = { kick: [], waiting: [] };
  let recrutamento = null;
  if (guildDiscordId) {
    const { params, channels } = await getConfig(guildDiscordId);
    recrutamento = { slots, esperando, canal: channels?.recruiters ?? null };
    const checks = await collections.inactivityChecks().find({}).toArray();
    const pointsByUuid = new Map(stats.map((s) => [s.uuid, s.points ?? 0]));
    // O `lastJoin` do endpoint de guilda às vezes fica para trás do jogo: quem
    // já voltou continuava na lista de kick. Mesma correção que o job usa.
    const members = await withObservedActivity(res.members, pointsByUuid, params);
    inactivity = inactivityStatus(members, pointsByUuid, params, checks);
  }

  return {
    verified,
    missingRecruiter,
    shouldBeRecruit,
    recruitNoLink,
    rankInGame,
    missingReq,
    inactivity,
    recrutamento,
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

/**
 * Um campo de uma linha por pessoa, cortado pelo fim se não couber, avisando
 * quantos ficaram de fora.
 * @param {string} desc    linha de explicação, já com `> ` e `\n`
 * @param {string[]} todas
 */
function linesValue(desc, todas) {
  const linhas = [];
  let len = desc.length;
  for (const linha of todas) {
    if (len + linha.length + 1 + RESTO_RESERVA > FIELD_LIMIT) break;
    linhas.push(linha);
    len += linha.length + 1;
  }
  const resto = todas.length - linhas.length;
  return `${desc}${linhas.join('\n')}${resto > 0 ? `\n-# … e mais ${resto}.` : ''}`;
}

const rotulo = (rank) => RANK_LABEL[rank] ?? rank;

/**
 * Rank no jogo × cargo de trilha no Discord: `⬆️ Nick Recrutador → Capitão`.
 * Sempre aparece, como a lista de kick: "ninguém" também é resposta.
 * @param {Array<{username: string, from: string, to: string, up: boolean}>} lista
 */
function rankField(lista) {
  const nome = `🎖️ Rank no jogo × cargo no Discord (${lista.length})`;
  if (!lista.length) return { name: nome, value: '> Todo rank no jogo bate com o cargo no Discord. 🎉' };
  const desc = '> ⬆️ promover / ⬇️ rebaixar no jogo, para o rank que o cargo no Discord pede.\n';
  const linhas = lista.map((p) => `${p.up ? '⬆️' : '⬇️'} \`${p.username}\` ${rotulo(p.from)} → **${rotulo(p.to)}**`);
  return { name: nome, value: linesValue(desc, linhas) };
}

/**
 * Cargo de trilha sem a meta: `Nick` Capitão (War): 20 de 50 guerras. Só
 * aparece quando há alguém — é exceção, não rotina.
 * @param {Array<{username: string, faltas: Array<{label: string, medida: string, tem: number, meta: number}>}>} lista
 */
function missingReqFields(lista) {
  if (!lista.length) return [];
  const fmt = (n) => Number(n).toLocaleString('pt-BR');
  const desc = '> Tem o cargo sem ter as guerras ou os pontos. O bot não tira: a staff decide.\n';
  const linhas = lista.map(
    (p) => `\`${p.username}\` ${p.faltas.map((f) => `${f.label}: ${fmt(f.tem)} de ${fmt(f.meta)} ${f.medida}`).join(' · ')}`,
  );
  return [{ name: `🏷️ Cargo sem a meta (${lista.length})`, value: linesValue(desc, linhas) }];
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
    (embed.description?.length ?? 0) +
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

/**
 * A única linha sobre recrutamento no relatório.
 *
 * Aparece só quando há vaga E gente esperando: fila sem vaga é espera
 * legítima, vaga sem fila não tem o que fazer, e um aviso que aparece sempre
 * deixa de ser lido. A lista em si mora no canal de recrutamento — repeti-la
 * aqui criaria duas cópias que divergem no primeiro convite.
 *
 * @param {{slots: number, esperando: number, canal: string|null}|null} r
 */
function linhaRecrutamento(r) {
  if (!r?.slots || !r?.esperando) return undefined;
  const vaga = r.slots === 1 ? "**1 vaga** livre" : `**${r.slots} vagas** livres`;
  const gente = r.esperando === 1 ? "**1 pessoa** aprovada esperando" : `**${r.esperando} pessoas** aprovadas esperando`;
  const onde = r.canal ? ` — convide em <#${r.canal}>` : "";
  return `📥 ${vaga} na guilda e ${gente}${onde}.`;
}

export function verificationEmbed(data) {
  return fitEmbed({
    title: 'Wynn Brasil [WnBR] — Verificação',
    color: 0x3498db,
    description: linhaRecrutamento(data.recrutamento),
    fields: [
      field('🔰 Membros verificados', 'Na guilda, Recruiter e com registro.', data.verified),
      field('⬆️ No Discord', 'Na guilda e com registro — falta virar Recruiter.', data.missingRecruiter),
      field('⬇️ Na guilda', 'Recruiter sem registro — deveria ser Recruit.', data.shouldBeRecruit),
      field('🤙 Sem vínculo no Discord', 'Recruit sem registro — tá certo. Vale convidar para o Discord: com registro, vira Recruiter.', data.recruitNoLink),
      // Depois das 4 listagens: o fitEmbed só encurta as 4 primeiras, e estas
      // são listas que a staff executa, como a de kick.
      rankField(data.rankInGame ?? []),
      ...missingReqFields(data.missingReq ?? []),
      ...inactivityFields(data.inactivity ?? { kick: [], waiting: [] }),
    ],
    footer: { text: 'Use /reconciliar para auditar cargos.' },
    timestamp: new Date().toISOString(),
  });
}
