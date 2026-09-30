import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { canVote, hasLevel, LEVEL } from './permissions.js';
import { eligibleVoterCount, tally, decide, labelFor } from './applications.js';
import { rankWeight } from './guildData.js';
import { plainMentions } from '../util/plainMentions.js';
import { log } from '../util/log.js';

/**
 * Trilhas de cargo: War (guerras pela WnBR) e Staff (pontos all-time).
 *
 * O cargo no DISCORD é do bot: ele dá, troca e anuncia. O rank no JOGO não — a
 * API é só leitura. Quem precisa subir lá aparece no /verificar, que compara o
 * cargo daqui com o rank de lá (ver expectedGameRank).
 *
 * No máximo um cargo por trilha, sempre o mais alto; as duas trilhas são
 * independentes. Nada aqui rebaixa: pontos all-time e o contador de guerras só
 * sobem, e um cargo dado à mão acima do limiar é decisão da staff.
 */
export const TRILHAS = Object.freeze({ capitaoWar: 50, estrategistaWar: 100, capitaoStaff: 2500, estrategistaStaff: 5000 });

const ROLE = Object.freeze({
  warTeam: '1554163813387993208',
  guildStaff: '1262574400587169863',
  capitaoWar: '1554261272755699722',
  estrategistaWar: '1554224233767239750',
  chefeWar: '1268208318439096461',
  capitaoStaff: '1268208319865159773',
  estrategistaStaff: '1268208318946742312',
  chefeStaff: '1554224233721372692',
  fundador: '1268208310423781426',
});

const CH_CHEFES = '1332548770940063776'; // canal dos Chefes (Staff)

const fmt = (n) => Number(n).toLocaleString('pt-BR');

/**
 * Cada trilha, do cargo mais alto para o mais baixo. `auto`: o bot dá sozinho
 * ao chegar lá. `vote`: o bot abre a votação dos Chefes (Staff). Sem nenhum dos
 * dois, o cargo é manual. `rank` é o rank do jogo que o cargo representa.
 * `confirm: 'fundador'`: aprovado na votação, só vale depois do clique do
 * Fundador (ver pedirFundador).
 *
 * A promoção é anunciada no canal de anúncios da PRÓPRIA trilha — nunca nos
 * anúncios gerais da WnBR.
 */
export const TRACKS = Object.freeze({
  war: Object.freeze({
    stat: 'guildWars',
    emoji: '⚔️',
    medida: 'guerras',
    unidade: (n) => `${fmt(n)} guerras pela WnBR`,
    team: ROLE.warTeam,
    anuncios: '1554170883432517675', // anúncios da War Team
    steps: Object.freeze([
      { key: 'chefeWar', role: ROLE.chefeWar, label: 'Chefe (War)', rank: 'chief' },
      { key: 'estrategistaWar', role: ROLE.estrategistaWar, label: 'Estrategista (War)', rank: 'strategist', auto: TRILHAS.estrategistaWar },
      { key: 'capitaoWar', role: ROLE.capitaoWar, label: 'Capitão (War)', rank: 'captain', auto: TRILHAS.capitaoWar },
    ]),
  }),
  staff: Object.freeze({
    stat: 'points',
    emoji: '🛡️',
    medida: 'pontos',
    unidade: (n) => `${fmt(n)} pontos`,
    team: ROLE.guildStaff,
    anuncios: '1554169631231451276', // anúncios da Staff
    steps: Object.freeze([
      { key: 'chefeStaff', role: ROLE.chefeStaff, label: 'Chefe (Staff)', rank: 'chief', confirm: 'fundador' },
      { key: 'estrategistaStaff', role: ROLE.estrategistaStaff, label: 'Estrategista (Staff)', rank: 'strategist', vote: TRILHAS.estrategistaStaff },
      { key: 'capitaoStaff', role: ROLE.capitaoStaff, label: 'Capitão (Staff)', rank: 'captain', auto: TRILHAS.capitaoStaff },
    ]),
  }),
});

const STEP_BY_KEY = new Map(Object.values(TRACKS).flatMap((t) => t.steps.map((s) => [s.key, s])));
const trackOf = (step) => Object.values(TRACKS).find((t) => t.steps.includes(step));

/**
 * O que fazer numa trilha. Puro, para dar para testar sem gateway.
 *
 * @param {object} track       um de TRACKS
 * @param {{has(id: string): boolean}} held  cargos do membro (Set, Collection…)
 * @param {number} valor       guerras ou pontos, conforme a trilha
 * @returns {{give: string|null, remove: string[], team: boolean, vote: string|null, top: string|null}}
 *   chaves de `steps`; `team` = falta o cargo de time (War Team / Guild Staff)
 */
export function planTrack(track, held, valor) {
  const tem = track.steps.filter((s) => held.has(s.role));
  const topo = tem[0] ?? null;
  // `find` pega o mais alto: os passos vêm de cima para baixo.
  const alvo = track.steps.find((s) => s.auto != null && valor >= s.auto) ?? null;
  const sobe = !!alvo && (!topo || track.steps.indexOf(alvo) < track.steps.indexOf(topo));
  const fica = sobe ? alvo : topo;

  // A votação só abre para quem está ABAIXO do cargo votado: quem já o tem, ou
  // tem um acima, não tem o que votar.
  const iFica = fica ? track.steps.indexOf(fica) : Infinity;
  const votado = track.steps.find((s, i) => s.vote != null && valor >= s.vote && i < iFica) ?? null;

  return {
    give: sobe ? alvo.key : null,
    remove: tem.filter((s) => s !== fica).map((s) => s.key),
    team: !!fica && !held.has(track.team),
    vote: votado?.key ?? null,
    top: fica?.key ?? null,
  };
}

/**
 * O rank do jogo que os cargos de trilha do membro pedem: o mais alto entre as
 * duas trilhas. `null` = nenhum cargo de trilha.
 * @param {{has(id: string): boolean}} held
 * @returns {string|null}
 */
export function expectedGameRank(held) {
  let melhor = null;
  for (const track of Object.values(TRACKS)) {
    const topo = track.steps.find((s) => held.has(s.role));
    if (topo && rankWeight(topo.rank) > rankWeight(melhor)) melhor = topo.rank;
  }
  return melhor;
}

/**
 * Cargos de trilha que o membro tem SEM ter a meta: o mais alto de cada trilha,
 * quando ele tem limiar (`auto` ou `vote`) e as guerras ou os pontos não chegam
 * lá. Chefe não tem meta, então nunca aparece. O bot não tira nada por isso —
 * cargo dado à mão é decisão da staff —, só aponta no /verificar.
 *
 * @param {{has(id: string): boolean}} held
 * @param {{points?: number, guildWars?: number}} stats
 * @returns {Array<{label: string, medida: string, tem: number, meta: number}>}
 */
export function missingRequirements(held, stats = {}) {
  const out = [];
  for (const track of Object.values(TRACKS)) {
    const topo = track.steps.find((s) => held.has(s.role));
    const meta = topo?.auto ?? topo?.vote;
    const tem = Number(stats?.[track.stat] ?? 0);
    if (meta != null && tem < meta) out.push({ label: topo.label, medida: track.medida, tem, meta });
  }
  return out;
}

/**
 * Manda as linhas de promoção no canal de anúncios da trilha, quantas
 * mensagens precisar. Pinga só a pessoa promovida; os cargos citados aparecem
 * sem pingar ninguém.
 * @param {import('discord.js').Client} client
 * @param {object} track  um de TRACKS
 * @param {Array<{userId: string, texto: string}>} linhas
 */
async function anunciar(client, track, linhas) {
  if (!linhas.length) return;
  const canal = await client.channels.fetch(track.anuncios).catch(() => null);
  if (!canal) {
    log.warn(`Canal de anúncios da trilha (${track.anuncios}) indisponível; promoções não anunciadas.`);
    return;
  }
  const CABECALHO = '## 🎖️ Promoções\n';
  const RODAPE = '\n-# O rank no jogo é dado pela staff.';
  let lote = [];
  let tamanho = CABECALHO.length + RODAPE.length;
  const enviar = async () => {
    if (!lote.length) return;
    await canal
      .send({
        content: `${CABECALHO}${lote.map((l) => l.texto).join('\n')}${RODAPE}`,
        allowedMentions: { users: [...new Set(lote.map((l) => l.userId))] },
      })
      .catch((e) => log.error('Falha ao anunciar promoções:', e));
    lote = [];
    tamanho = CABECALHO.length + RODAPE.length;
  };
  for (const l of linhas) {
    if (tamanho + l.texto.length + 1 > 2000) await enviar();
    lote.push(l);
    tamanho += l.texto.length + 1;
  }
  await enviar();
}

/**
 * Dá e tira cargos UM POR VEZ, e anota a mudança em `held`.
 *
 * Nunca em lista: `roles.add([...])` e `roles.remove([...])` do discord.js
 * regravam a lista INTEIRA de cargos a partir do cache, que só se atualiza
 * quando o evento do gateway chega. Um `add` seguido de `remove` em lista
 * desfazia o `add` — foi assim que um Estrategista (Staff) recém-aprovado ficou
 * sem cargo e ganhou Capitão de novo no ciclo seguinte. Um por vez, cada chamada
 * mexe só no próprio cargo.
 *
 * `held` é a visão local dos cargos do membro: o cache está atrasado, e o que
 * vem depois no mesmo ciclo precisa ver o que acabou de mudar.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {Set<string>} held
 * @param {string[]} dar
 * @param {string[]} tirar
 * @param {string} motivo
 * @returns {Promise<boolean>} se todos os cargos de `dar` entraram
 */
async function trocarCargos(member, held, dar, tirar, motivo) {
  for (const id of dar) {
    if (held.has(id)) continue;
    const ok = await member.roles.add(id, motivo).then(() => true, () => false);
    if (!ok) return false;
    held.add(id);
  }
  for (const id of tirar) {
    if (!held.has(id)) continue;
    await member.roles.remove(id, motivo).catch(() => {});
    held.delete(id);
  }
  return true;
}

/**
 * Põe o cargo de uma votação aprovada: o cargo (e o de time, se faltar) entra,
 * e os de baixo da mesma trilha saem. Quem já tem um cargo acima fica como está.
 * @returns {Promise<'aplicado'|'ja-tinha'|'falhou'>}
 */
async function aplicarVotado(member, held, step, motivo) {
  const track = trackOf(step);
  const comVotado = { has: (rid) => rid === step.role || held.has(rid) };
  const plano = planTrack(track, comVotado, 0);
  if (plano.top !== step.key) return 'ja-tinha';
  if (held.has(step.role) && !plano.remove.length && !plano.team) return 'ja-tinha';
  const dar = [step.role, plano.team && track.team].filter(Boolean);
  const tirar = plano.remove.map((k) => STEP_BY_KEY.get(k).role);
  return (await trocarCargos(member, held, dar, tirar, motivo)) ? 'aplicado' : 'falhou';
}

/** Folga antes de o reparo mexer numa votação: quem a decidiu ainda pode estar aplicando. */
const REPARO_FOLGA_MS = 5 * 60_000;

/**
 * Votações aprovadas cujo cargo não ficou: a aplicação falhou (cargo do bot
 * abaixo, Discord fora) ou é de antes da correção de `trocarCargos`. O cargo é
 * devido, então entra aqui, sem anúncio — a aprovação já foi anunciada.
 *
 * `settledAt` é quando o cargo passou a ser devido: o fim da votação, ou o
 * clique do Fundador. Votação antiga não tem o campo e vale pelo `decidedAt`.
 */
async function repararVotados(client, guild, alvos, heldOf) {
  const limite = new Date(Date.now() - REPARO_FOLGA_MS);
  const pendentes = await collections
    .promotionVotes()
    .find({
      discordId: { $in: alvos.map((a) => a.member.id) },
      status: 'approved',
      appliedAt: { $exists: false },
      $or: [
        { settledAt: { $lte: limite } },
        { settledAt: { $exists: false }, owner: { $exists: false }, decidedAt: { $lte: limite } },
      ],
    })
    .toArray();

  for (const v of pendentes) {
    const alvo = alvos.find((a) => a.member.id === v.discordId);
    const step = STEP_BY_KEY.get(v.role);
    const res = await aplicarVotado(alvo.member, heldOf.get(alvo.member.id), step, 'Votação aprovada (reparo)');
    if (res === 'falhou') continue;
    await collections.promotionVotes().updateOne({ _id: v._id }, { $set: { appliedAt: new Date() } });
    if (res === 'aplicado') {
      await audit(client, guild.id, `🔧 <@${v.discordId}> recebeu <@&${step.role}>, aprovado em votação — o cargo não tinha ficado.`);
    }
  }
}

/**
 * Aplica as trilhas a quem está na guilda: dá o cargo que a pessoa alcançou,
 * tira os de baixo da mesma trilha, garante o cargo de time e abre a votação
 * quando o próximo passo é votado. Chamado pelo roleSync a cada ciclo.
 *
 * Só quem está NA GUILDA: cargo de trilha fora dela viraria Ocioso no mesmo
 * ciclo, e o contador de guerras só conta as feitas pela WnBR mesmo.
 *
 * O primeiro ciclo pega todo mundo que já tinha passado dos limiares, e o
 * anúncio sai numa mensagem só por trilha (ou poucas), não uma por pessoa.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {Array<{member: import('discord.js').GuildMember, uuid: string, nome: string}>} alvos
 */
export async function syncTrailRoles(client, guild, alvos) {
  if (!alvos.length) return;
  const stats = await collections
    .guildStats()
    .find({ uuid: { $in: alvos.map((a) => a.uuid) } }, { projection: { uuid: 1, points: 1, guildWars: 1 } })
    .toArray();
  const statsByUuid = new Map(stats.map((s) => [s.uuid, s]));
  const heldOf = new Map(alvos.map((a) => [a.member.id, new Set(a.member.roles.cache.keys())]));

  // Antes das trilhas: o cargo votado muda o que a trilha enxerga.
  await repararVotados(client, guild, alvos, heldOf);

  const anuncios = new Map(Object.values(TRACKS).map((t) => [t, []]));
  const ajustes = [];
  for (const { member, uuid, nome } of alvos) {
    const s = statsByUuid.get(uuid) ?? {};
    const held = heldOf.get(member.id);
    for (const track of Object.values(TRACKS)) {
      const valor = Number(s[track.stat] ?? 0);
      const plano = planTrack(track, held, valor);

      const dar = [plano.give && STEP_BY_KEY.get(plano.give).role, plano.team && track.team].filter(Boolean);
      const tirar = plano.remove.map((k) => STEP_BY_KEY.get(k).role);
      const ok = await trocarCargos(member, held, dar, tirar, 'Trilha de cargo');

      if (!ok) {
        ajustes.push(`⚠️ Não consegui dar ${dar.map((id) => `<@&${id}>`).join(' e ')} a <@${member.id}> — o cargo do bot está abaixo?`);
      } else if (plano.give) {
        const time = plano.team ? ` e <@&${track.team}>` : '';
        anuncios.get(track).push({
          userId: member.id,
          texto: `${track.emoji} <@${member.id}> chegou a **${track.unidade(valor)}** → <@&${STEP_BY_KEY.get(plano.give).role}>${time}`,
        });
      } else if (plano.team || tirar.length) {
        // Arrumação sem promoção: cargo de time faltando, ou dois cargos na
        // mesma trilha. Não é notícia para a guilda, só para a auditoria.
        const partes = [];
        if (plano.team) partes.push(`ganhou <@&${track.team}>`);
        if (tirar.length) partes.push(`perdeu ${tirar.map((id) => `<@&${id}>`).join(', ')}`);
        ajustes.push(`🧹 <@${member.id}> ${partes.join(' e ')} — já tem <@&${STEP_BY_KEY.get(plano.top).role}>.`);
      }

      // A votação automática abre UMA vez por pessoa e cargo: reprovada, só um
      // Chefe a reabre, com /promocao abrir.
      if (plano.vote && !(await collections.promotionVotes().findOne({ discordId: member.id, role: plano.vote }))) {
        await openVote(client, guild, { member, uuid, nome, step: STEP_BY_KEY.get(plano.vote), valor });
      }
    }
  }

  let total = 0;
  for (const [track, linhas] of anuncios) {
    await anunciar(client, track, linhas);
    total += linhas.length;
  }
  if (total) await audit(client, guild.id, `🎖️ ${total} promoção(ões) de trilha no Discord — o rank no jogo aparece no /verificar.`);
  for (const linha of ajustes) await audit(client, guild.id, linha);
}

// ───────────────────────────────────────────────────── Votação de promoção

/** Prefixo dos botões. O /promocao os adota, inclusive os da DM do Fundador. */
export const PROMO_PREFIX = 'promo:';

/**
 * Só Aprovar e Reprovar. Não votar JÁ é abster-se: a regra conta a maioria dos
 * votos dados, então um botão de abstenção não mudaria resultado nenhum.
 */
const CHOICES = Object.freeze(['approve', 'reject']);

function voteButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    CHOICES.map((choice) =>
      new ButtonBuilder()
        .setCustomId(`${PROMO_PREFIX}vote:${id}:${choice}`)
        .setLabel(labelFor(choice))
        .setStyle(choice === 'approve' ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(disabled),
    ),
  );
}

// Voto anônimo: a mensagem mostra só os totais, nunca quem votou o quê. Quem
// votou fica no banco só para garantir um voto por pessoa.
function voteEmbed(v, eligibleCount) {
  const { approve, reject } = tally(v.votes);
  const step = STEP_BY_KEY.get(v.role);
  const aberta = v.openedBy ? `Aberta por <@${v.openedBy}>. ` : '';
  const fundador = step.confirm === 'fundador' ? '\nAprovada, ainda precisa da confirmação do Fundador.' : '';
  return {
    title: `Promoção — ${v.username}`,
    description: `${aberta}<@${v.discordId}> tem **${trackOf(step).unidade(v.reached)}** e pode subir a <@&${step.role}>.${fundador}`,
    color: 0xf1c40f,
    fields: [
      { name: 'Aprovar', value: String(approve), inline: true },
      { name: 'Reprovar', value: String(reject), inline: true },
      { name: 'Eleitores elegíveis', value: String(eligibleCount), inline: true },
      { name: 'Encerra', value: `<t:${Math.floor(new Date(v.expiresAt).getTime() / 1000)}:R>`, inline: true },
    ],
    footer: { text: `Voto anônimo, um por Chefe · quem não vota se abstém · ID: ${v._id}` },
  };
}

/**
 * A mensagem da votação. `ping` só na abertura: reenviar uma votação apagada
 * não chama os Chefes de novo.
 */
function votePayload(v, eligibleCount, ping) {
  return {
    content: `<@&${ROLE.chefeStaff}> votação de promoção.`,
    embeds: [voteEmbed(v, eligibleCount)],
    components: [voteButtons(v._id.toString())],
    allowedMentions: ping ? { roles: [ROLE.chefeStaff] } : { parse: [] },
  };
}

/**
 * Abre a votação dos Chefes (Staff) no canal deles. Serve à automática (5.000
 * pontos) e à aberta por um Chefe (`openedBy`).
 *
 * A mensagem sai ANTES do registro, com o id gerado aqui: votação aberta sem
 * mensagem seria reenviada pelo job de reenvio, que roda em paralelo, e o canal
 * ganharia duas. Se a mensagem não sair, nada é gravado.
 *
 * @returns {Promise<boolean>} se abriu
 */
async function openVote(client, guild, { member, uuid, nome, step, valor, openedBy = null }) {
  const canal = await client.channels.fetch(CH_CHEFES).catch(() => null);
  if (!canal) {
    log.warn('Canal dos Chefes indisponível; votação de promoção não aberta.');
    return false;
  }

  const cfg = await getConfig(guild.id);
  const hours = Number(cfg.params?.voteWindowHours) || 24;
  const now = new Date();
  const track = trackOf(step);
  const doc = {
    _id: new ObjectId(),
    guildDiscordId: guild.id,
    discordId: member.id,
    uuid,
    username: nome,
    role: step.key,
    stat: track.stat,
    reached: valor,
    openedBy,
    status: 'open',
    votes: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + hours * 3_600_000),
    channelId: canal.id,
  };

  const eligibleCount = await eligibleVoterCount(guild);
  const msg = await canal.send(votePayload(doc, eligibleCount, true)).catch((e) => {
    log.error('Falha ao abrir votação de promoção:', e);
    return null;
  });
  if (!msg) return false;
  const gravou = await collections
    .promotionVotes()
    .insertOne({ ...doc, messageId: msg.id })
    .then(
      () => true,
      (e) => {
        log.error('Falha ao gravar votação de promoção:', e);
        return false;
      },
    );
  // Sem registro, os botões não achariam votação nenhuma.
  if (!gravou) {
    await msg.delete().catch(() => {});
    return false;
  }
  const quem = openedBy ? ` por <@${openedBy}>` : '';
  await audit(client, guild.id, `🗳️ Votação aberta${quem}: <@${member.id}> (**${nome}**) para <@&${step.role}> — ${track.unidade(valor)}.`);
  return true;
}

/**
 * Para que cargo um Chefe pode abrir votação com /promocao, e para quem.
 * `abaixo`: o cargo que a pessoa tem que ter hoje (um degrau por vez).
 * `minimo`: a meta da trilha, quando o cargo tem uma.
 */
export const MANUAL_VOTE = Object.freeze({
  estrategistaStaff: Object.freeze({ abaixo: 'capitaoStaff', minimo: TRILHAS.estrategistaStaff }),
  chefeStaff: Object.freeze({ abaixo: 'estrategistaStaff' }),
});

/**
 * /promocao abrir: um Chefe (Staff) abre a votação. Serve para Chefe (Staff), e
 * para REABRIR Estrategista (Staff) de quem já tem a meta — a votação
 * automática só abre uma vez.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {{alvoId: string, cargo: string, por: import('discord.js').GuildMember}} args
 * @returns {Promise<string>} a resposta para quem abriu
 */
export async function openManualVote(client, guild, { alvoId, cargo, por }) {
  const step = STEP_BY_KEY.get(cargo);
  const regra = MANUAL_VOTE[cargo];
  if (!step || !regra) return 'Cargo inválido.';
  // O nível do comando já exige Chefe; aqui sai quem está Ocioso.
  if (!hasLevel(por, LEVEL.FUNDADOR) && !canVote(por)) return 'Chefe Ocioso não abre votação.';

  const link = await collections.members().findOne({ discordId: alvoId });
  if (!link) return 'Essa pessoa não tem registro.';
  if (!link.inGuild) return 'Essa pessoa não está na guilda.';
  const member = await guild.members.fetch({ user: alvoId, force: true }).catch(() => null);
  if (!member) return 'Essa pessoa não está no Discord.';

  const track = trackOf(step);
  const topo = track.steps.find((s) => member.roles.cache.has(s.role));
  const abaixo = STEP_BY_KEY.get(regra.abaixo);
  if (topo?.key !== abaixo.key) return `Só abre para quem é **${abaixo.label}** hoje, um degrau por vez.`;

  const stats = await collections.guildStats().findOne({ uuid: link.uuid });
  const valor = Number(stats?.[track.stat] ?? 0);
  if (regra.minimo != null && valor < regra.minimo) {
    return `Precisa de **${track.unidade(regra.minimo)}**, e tem ${fmt(valor)}.`;
  }

  const votes = collections.promotionVotes();
  if (await votes.findOne({ discordId: alvoId, role: cargo, status: 'open' })) {
    return 'Já tem uma votação aberta para isso.';
  }
  if (await votes.findOne({ discordId: alvoId, role: cargo, status: 'approved', owner: 'pending' })) {
    return 'Já foi aprovada e está esperando a confirmação do Fundador.';
  }

  const abriu = await openVote(client, guild, { member, uuid: link.uuid, nome: link.username, step, valor, openedBy: por.id });
  return abriu ? `Votação aberta em <#${CH_CHEFES}>.` : 'Não consegui abrir a votação: o canal dos Chefes está acessível?';
}

/** Troca o resultado mostrado na mensagem da votação. Some calado se ela sumiu. */
async function mostrarResultado(client, v, texto, cor) {
  try {
    const canal = await client.channels.fetch(v.channelId);
    const msg = await canal.messages.fetch(v.messageId);
    const guild = await client.guilds.fetch(v.guildDiscordId).catch(() => null);
    const embed = voteEmbed(v, guild ? await eligibleVoterCount(guild) : 0);
    embed.color = cor;
    embed.fields.push({ name: 'Resultado', value: texto });
    await msg.edit({ embeds: [embed], components: [voteButtons(v._id.toString(), true)] });
  } catch (e) {
    log.error('Falha ao editar mensagem da votação de promoção:', e);
  }
}

/**
 * Aplica o cargo votado a quem está no Discord e anuncia. Sem conseguir, deixa
 * sem `appliedAt`, e o reparo do roleSync tenta de novo.
 */
async function concluirPromocao(client, guild, v, anuncio) {
  const step = STEP_BY_KEY.get(v.role);
  const track = trackOf(step);
  // `force`: o cache pode estar atrasado, e é dele que sai o que tirar.
  const member = guild ? await guild.members.fetch({ user: v.discordId, force: true }).catch(() => null) : null;
  if (!member) {
    await audit(client, v.guildDiscordId, `⚠️ **${v.username}** não está no Discord — <@&${step.role}> fica para quando voltar.`);
    return;
  }
  const res = await aplicarVotado(member, new Set(member.roles.cache.keys()), step, 'Promoção aprovada');
  if (res === 'falhou') {
    await audit(client, v.guildDiscordId, `⚠️ Não consegui dar <@&${step.role}> a <@${member.id}> — o cargo do bot está abaixo?`);
    return;
  }
  await collections.promotionVotes().updateOne({ _id: v._id }, { $set: { appliedAt: new Date() } });
  if (res === 'aplicado') await anunciar(client, track, [{ userId: member.id, texto: anuncio(member, step, track) }]);
}

/**
 * Encerra a votação e, aprovada, troca o cargo — ou, para Chefe (Staff), pede a
 * confirmação do Fundador.
 *
 * O status muda num update condicional ANTES de qualquer efeito: o último voto
 * e o job de prazo podem chegar juntos, e só um deles deve aplicar e anunciar.
 */
export async function finalizePromotionVote(client, id, cause = 'deadline') {
  const votes = collections.promotionVotes();
  const _id = typeof id === 'string' ? new ObjectId(id) : id;
  const v = await votes.findOne({ _id, status: 'open' });
  if (!v) return null;

  const cfg = await getConfig(v.guildDiscordId);
  const guild = await client.guilds.fetch(v.guildDiscordId).catch(() => null);
  const eligibleCount = guild ? await eligibleVoterCount(guild) : 0;
  const result = decide(v.votes, cfg.params?.voteRule || 'effective', eligibleCount);
  const step = STEP_BY_KEY.get(v.role);
  const doFundador = result === 'approved' && step.confirm === 'fundador';

  const $set = { status: result, decidedAt: new Date(), decidedBy: cause };
  if (doFundador) $set.owner = 'pending';
  else if (result === 'approved') $set.settledAt = new Date();
  const { modifiedCount } = await votes.updateOne({ _id, status: 'open' }, { $set });
  if (!modifiedCount) return null;
  Object.assign(v, $set);

  const texto = result !== 'approved' ? '❌ Reprovada' : doFundador ? '✅ Aprovada — aguardando o Fundador' : '✅ Aprovada';
  await mostrarResultado(client, v, texto, result === 'approved' ? 0x2ecc71 : 0xe74c3c);
  await audit(
    client,
    v.guildDiscordId,
    `Promoção de **${v.username}** a <@&${step.role}>: ${result === 'approved' ? '✅ aprovada' : '❌ reprovada'} (${cause}).`,
  );
  if (result !== 'approved') return result;

  if (doFundador) {
    await pedirFundador(client, guild, v);
    return result;
  }
  await concluirPromocao(
    client,
    guild,
    v,
    (member, s, track) => `${track.emoji} <@${member.id}> foi aprovado pelos <@&${ROLE.chefeStaff}> → <@&${s.role}>`,
  );
  return result;
}

// ─────────────────────────────────────────── Confirmação do Fundador (Chefe)

function ownerButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PROMO_PREFIX}owner:${id}:confirm`)
      .setLabel('Confirmar')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${PROMO_PREFIX}owner:${id}:decline`)
      .setLabel('Recusar')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

/**
 * O pedido de confirmação. Vai por DM, onde menção de cargo não resolve: nomes
 * em texto puro.
 */
async function ownerPayload(client, guild, v, decisao = null) {
  const step = STEP_BY_KEY.get(v.role);
  const { approve, reject } = tally(v.votes);
  const texto = await plainMentions(
    client,
    guild,
    `<@${v.discordId}> (**${v.username}**) foi aprovado pelos Chefes (Staff) para **${step.label}**, ${approve} a ${reject}. ` +
      'Só vale depois da sua confirmação.',
  );
  const fim = decisao === 'confirm' ? '✅ Confirmada' : decisao === 'decline' ? '❌ Recusada' : null;
  return {
    embeds: [
      {
        title: `🛡️ Promoção a ${step.label}`,
        description: fim ? `${texto}\n\n**${fim}.**` : texto,
        color: fim ? (decisao === 'confirm' ? 0x2ecc71 : 0xe74c3c) : 0xf1c40f,
        footer: { text: `ID: ${v._id}` },
      },
    ],
    components: [ownerButtons(v._id.toString(), !!fim)],
    allowedMentions: { parse: [] },
  };
}

/**
 * Chefe (Staff) aprovado só vale com o clique do Fundador: DM a cada um. Se
 * nenhuma DM passar, o pedido vai para o canal dos Chefes — só o Fundador
 * consegue clicar.
 */
async function pedirFundador(client, guild, v) {
  if (!guild) return;
  const payload = await ownerPayload(client, guild, v);
  await guild.members.fetch().catch(() => {});
  const fundadores = guild.roles.cache.get(ROLE.fundador)?.members ?? new Map();
  let entregues = 0;
  for (const m of fundadores.values()) {
    if (m.user.bot) continue;
    if (await m.send(payload).then(() => true, () => false)) entregues += 1;
  }
  if (!entregues) {
    const canal = await client.channels.fetch(CH_CHEFES).catch(() => null);
    await canal?.send(payload).catch(() => {});
  }
  await audit(
    client,
    guild.id,
    `📨 Promoção de **${v.username}** a <@&${STEP_BY_KEY.get(v.role).role}> aguardando o Fundador` +
      (entregues ? ' (DM enviada).' : ' — DM fechada, o pedido foi para o canal dos Chefes.'),
  );
}

/** Botões `promo:owner:<id>:confirm|decline`, na DM do Fundador. */
async function handleOwnerButton(interaction, id, decisao) {
  const client = interaction.client;
  const v0 = await collections.promotionVotes().findOne({ _id: new ObjectId(id) });
  if (!v0) return interaction.reply({ content: 'Votação não encontrada.', ephemeral: true });
  const guild = await client.guilds.fetch(v0.guildDiscordId).catch(() => null);
  const quem = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
  const fundador = guild?.ownerId === interaction.user.id || !!quem?.roles.cache.has(ROLE.fundador);
  if (!fundador) return interaction.reply({ content: 'Só o Fundador confirma promoção a Chefe (Staff).', ephemeral: true });

  const agora = new Date();
  const $set = { owner: decisao === 'confirm' ? 'confirmed' : 'declined', ownerBy: interaction.user.id, ownerAt: agora };
  if (decisao === 'confirm') $set.settledAt = agora;
  // Condicional: com mais de um Fundador, vale o primeiro clique.
  const v = await collections
    .promotionVotes()
    .findOneAndUpdate({ _id: v0._id, status: 'approved', owner: 'pending' }, { $set }, { returnDocument: 'after' });
  if (!v) return interaction.reply({ content: 'Esta promoção já foi decidida.', ephemeral: true });

  await interaction.update(await ownerPayload(client, guild, v, decisao));
  const step = STEP_BY_KEY.get(v.role);
  await mostrarResultado(
    client,
    v,
    decisao === 'confirm' ? '✅ Aprovada e confirmada pelo Fundador' : '❌ Aprovada, mas recusada pelo Fundador',
    decisao === 'confirm' ? 0x2ecc71 : 0xe74c3c,
  );
  await audit(
    client,
    v.guildDiscordId,
    `${decisao === 'confirm' ? '✅' : '❌'} <@${interaction.user.id}> ${decisao === 'confirm' ? 'confirmou' : 'recusou'} a promoção de **${v.username}** a <@&${step.role}>.`,
  );
  if (decisao !== 'confirm') return;
  await concluirPromocao(
    client,
    guild,
    v,
    (member, s, track) =>
      `${track.emoji} <@${member.id}> foi aprovado pelos <@&${ROLE.chefeStaff}> e confirmado pelo Fundador → <@&${s.role}>`,
  );
}

// ─────────────────────────────────────────────────────────── Botões e jobs

/** Todo botão `promo:*`: voto dos Chefes e confirmação do Fundador. */
export async function handlePromotionButton(interaction) {
  const [, action, id, choice] = interaction.customId.split(':');
  if (!ObjectId.isValid(id)) return;
  if (action === 'owner' && ['confirm', 'decline'].includes(choice)) return handleOwnerButton(interaction, id, choice);
  if (action !== 'vote') return;
  // Botão de abstenção de uma mensagem antiga, de antes de ele sair.
  if (!CHOICES.includes(choice)) {
    return interaction.reply({ content: 'Para se abster, é só não votar.', ephemeral: true });
  }
  if (!canVote(interaction.member)) {
    return interaction.reply({ content: 'Só os Chefes (Staff) votam promoção.', ephemeral: true });
  }

  // Um voto por pessoa, numa operação só: tira o voto anterior deste Chefe e
  // põe o novo no MESMO update. Ler, mudar e regravar a lista perderia o voto
  // de quem clicasse no mesmo instante, e dois cliques rápidos da mesma pessoa
  // podiam deixá-la com dois votos.
  const voter = interaction.user.id;
  const v = await collections.promotionVotes().findOneAndUpdate(
    { _id: new ObjectId(id), status: 'open' },
    [
      {
        $set: {
          votes: {
            $concatArrays: [
              { $filter: { input: { $ifNull: ['$votes', []] }, cond: { $ne: ['$$this.voterDiscordId', voter] } } },
              [{ voterDiscordId: voter, choice, at: new Date() }],
            ],
          },
        },
      },
    ],
    { returnDocument: 'after' },
  );
  if (!v) return interaction.reply({ content: 'Esta votação já foi encerrada.', ephemeral: true });

  const eligibleCount = await eligibleVoterCount(interaction.guild);
  await interaction.update({ embeds: [voteEmbed(v, eligibleCount)], components: [voteButtons(id)] });
  await interaction.followUp({
    content: `Voto registrado: **${labelFor(choice)}**. Ninguém vê o seu voto; clicar no outro botão troca.`,
    ephemeral: true,
  });

  const { approve, reject } = tally(v.votes);
  if (eligibleCount > 0 && approve + reject >= eligibleCount) {
    await finalizePromotionVote(interaction.client, id, 'all-voted');
  }
}

/** Código do Discord para "mensagem não existe" — foi apagada. */
const UNKNOWN_MESSAGE = 10008;

/**
 * Reenvia a mensagem de toda votação ABERTA que foi apagada, com os votos que
 * ela já tinha. Os votos vivem no banco, então apagar a mensagem não apaga a
 * votação — só a tira da vista dos Chefes, e ela expiraria sem voto.
 *
 * Só reenvia quando o Discord confirma que a mensagem não existe: um erro de
 * rede não pode virar votação duplicada no canal.
 */
async function ensureVoteMessages(client) {
  const abertas = await collections.promotionVotes().find({ status: 'open' }).toArray();
  for (const v of abertas) {
    const canal = await client.channels.fetch(v.channelId ?? CH_CHEFES).catch(() => null);
    if (!canal) continue;
    const guild = await client.guilds.fetch(v.guildDiscordId).catch(() => null);
    const eligibleCount = async () => (guild ? eligibleVoterCount(guild) : 0);

    if (v.messageId) {
      const achou = await canal.messages.fetch({ message: v.messageId, force: true }).then(
        (msg) => ({ msg }),
        (erro) => ({ erro }),
      );
      if (achou.msg) {
        // Mensagem aberta antes de o Abster sair ainda tem três botões: troca
        // pelos dois de agora, uma vez só.
        if (achou.msg.components?.[0]?.components?.length !== CHOICES.length) {
          const { embeds, components } = votePayload(v, await eligibleCount(), false);
          await achou.msg.edit({ embeds, components }).catch(() => {});
        }
        continue;
      }
      if (achou.erro?.code !== UNKNOWN_MESSAGE) continue;
    }

    const msg = await canal.send(votePayload(v, await eligibleCount(), false)).catch((e) => {
      log.error('Falha ao reenviar votação de promoção:', e);
      return null;
    });
    if (!msg) continue;
    await collections
      .promotionVotes()
      .updateOne({ _id: v._id }, { $set: { messageId: msg.id, channelId: canal.id } });
    await audit(client, v.guildDiscordId, `🔁 A votação de promoção de **${v.username}** foi apagada e reenviada, com os votos que já tinha.`);
  }
}

/**
 * A cada minuto: fecha as votações vencidas e reenvia as abertas que tiveram a
 * mensagem apagada.
 */
export async function runPromotionVoteExpiry(client) {
  const vencidas = await collections
    .promotionVotes()
    .find({ status: 'open', expiresAt: { $lte: new Date() } })
    .toArray();
  for (const v of vencidas) await finalizePromotionVote(client, v._id, 'deadline');
  await ensureVoteMessages(client);
}
