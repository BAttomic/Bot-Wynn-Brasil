import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { canVote, hasLevel, LEVEL } from './permissions.js';
import { eligibleVoterCount, tally, decide, labelFor } from './applications.js';
import { rankWeight, RANK_LABEL } from './guildData.js';
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
 * independentes. A trilha nunca rebaixa sozinha: pontos all-time e o contador
 * de guerras só sobem, e um cargo dado à mão acima do limiar é decisão da staff.
 * Rebaixar é só por votação dos Chefes (/rebaixar, ver openDemoteVote).
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
 * @param {Set<string>} [travados]  chaves de `steps` que a pessoa perdeu em
 *   rebaixamento: o bot não as devolve sozinho, só a staff, à mão
 * @returns {{give: string|null, remove: string[], team: boolean, vote: string|null, top: string|null}}
 *   chaves de `steps`; `team` = falta o cargo de time (War Team / Guild Staff)
 */
export function planTrack(track, held, valor, travados = new Set()) {
  const tem = track.steps.filter((s) => held.has(s.role));
  const topo = tem[0] ?? null;
  // `find` pega o mais alto: os passos vêm de cima para baixo.
  const alvo = track.steps.find((s) => s.auto != null && valor >= s.auto && !travados.has(s.key)) ?? null;
  const sobe = !!alvo && (!topo || track.steps.indexOf(alvo) < track.steps.indexOf(topo));
  const fica = sobe ? alvo : topo;

  // A votação só abre para quem está ABAIXO do cargo votado: quem já o tem, ou
  // tem um acima, não tem o que votar. E só para quem tem cargo na trilha: o
  // rebaixado a Recrutador, com os pontos, não pula direto para a votação.
  const iFica = fica ? track.steps.indexOf(fica) : -1;
  const votado = track.steps.find((s, i) => s.vote != null && valor >= s.vote && i < iFica && !travados.has(s.key)) ?? null;

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

/**
 * Tira os cargos da trilha acima de `para` e põe `para`. `para` nulo é
 * Recrutador: sai da trilha inteira, e o cargo de time (WnBR Guild Staff) sai
 * junto. Quem já não tem o que tirar fica como está: alguém o tirou à mão antes.
 *
 * O de baixo entra PRIMEIRO. Se tirar falhar, a pessoa fica com os dois, e o
 * reparo tenta de novo; na ordem inversa, uma falha ao dar deixaria a pessoa
 * sem cargo nenhum, e o reparo não teria mais o que tirar.
 * @returns {Promise<'aplicado'|'ja-tinha'|'falhou'>}
 */
async function aplicarRebaixamento(member, held, de, para, motivo) {
  const track = trackOf(de);
  const acima = para ? track.steps.slice(0, track.steps.indexOf(para)) : track.steps;
  const tirar = [...acima.map((s) => s.role), !para && track.team].filter(Boolean);
  if (!tirar.some((id) => held.has(id))) return 'ja-tinha';
  if (para && !(await trocarCargos(member, held, [para.role], [], motivo))) return 'falhou';
  for (const id of tirar) {
    if (!held.has(id)) continue;
    const tirou = await member.roles.remove(id, motivo).then(() => true, () => false);
    if (!tirou) return 'falhou';
    held.delete(id);
  }
  return 'aplicado';
}

/** Aplica o resultado de uma votação aprovada, de promoção ou de rebaixamento. */
function aplicarDecisao(member, held, v, motivo) {
  const step = STEP_BY_KEY.get(v.role);
  return v.kind === DEMOTE
    ? aplicarRebaixamento(member, held, step, v.to ? STEP_BY_KEY.get(v.to) : null, motivo)
    : aplicarVotado(member, held, step, motivo);
}

/**
 * Cargos de trilha que a trilha não dá nem vota sozinha para cada pessoa: os
 * acima do destino de um rebaixamento aprovado. Sem isso, o Capitão (Staff)
 * rebaixado a Recrutador ganharia o cargo de volta no ciclo seguinte, pelos
 * pontos, e o Estrategista rebaixado ganharia outra votação automática.
 *
 * Vale a ordem das decisões: uma promoção votada depois destrava o cargo dela e
 * os de baixo. A staff também pode devolver o cargo à mão.
 * @returns {Promise<Map<string, Set<string>>>} discordId → chaves de `steps`
 */
async function cargosTravados(discordIds) {
  const docs = await collections
    .promotionVotes()
    .find(
      { discordId: { $in: discordIds }, status: 'approved', owner: { $nin: ['pending', 'declined'] } },
      { projection: { discordId: 1, role: 1, kind: 1, to: 1, settledAt: 1, decidedAt: 1 } },
    )
    .toArray();
  const quando = (d) => new Date(d.settledAt ?? d.decidedAt ?? 0).getTime();
  docs.sort((a, b) => quando(a) - quando(b));

  const out = new Map();
  for (const d of docs) {
    const step = STEP_BY_KEY.get(d.role);
    if (!step) continue;
    const { steps } = trackOf(step);
    const travados = out.get(d.discordId) ?? new Set();
    if (d.kind === DEMOTE) {
      const destino = d.to ? steps.indexOf(STEP_BY_KEY.get(d.to)) : steps.length;
      for (const s of steps.slice(0, destino)) travados.add(s.key);
    } else {
      for (const s of steps.slice(steps.indexOf(step))) travados.delete(s.key);
    }
    out.set(d.discordId, travados);
  }
  return out;
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
    const res = await aplicarDecisao(alvo.member, heldOf.get(alvo.member.id), v, 'Votação aprovada (reparo)');
    if (res === 'falhou') continue;
    await collections.promotionVotes().updateOne({ _id: v._id }, { $set: { appliedAt: new Date() } });
    if (res !== 'aplicado') continue;
    const texto =
      v.kind === DEMOTE
        ? `🔧 <@${v.discordId}> perdeu <@&${step.role}>, rebaixado em votação — o cargo tinha ficado.`
        : `🔧 <@${v.discordId}> recebeu <@&${step.role}>, aprovado em votação — o cargo não tinha ficado.`;
    await audit(client, guild.id, texto);
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
  const travadosOf = await cargosTravados(alvos.map((a) => a.member.id));

  const anuncios = new Map(Object.values(TRACKS).map((t) => [t, []]));
  const ajustes = [];
  for (const { member, uuid, nome } of alvos) {
    const s = statsByUuid.get(uuid) ?? {};
    const held = heldOf.get(member.id);
    for (const track of Object.values(TRACKS)) {
      const valor = Number(s[track.stat] ?? 0);
      const plano = planTrack(track, held, valor, travadosOf.get(member.id));

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
      // Chefe a reabre, com /promover. Quem foi rebaixado do cargo nem
      // chega aqui: ele está travado (cargosTravados).
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

// ───────────────────────────────────────── Votação de promoção e rebaixamento

/** Prefixo dos botões. O /promover os adota, inclusive os da DM do Fundador. */
export const PROMO_PREFIX = 'promo:';

/**
 * `kind` da votação de rebaixamento. Ela mora na mesma coleção e usa o mesmo
 * voto, prazo e confirmação do Fundador; `role` é o cargo que a pessoa PERDE, e
 * `to`, o de baixo, que ela ganha. Votação sem `kind` é de promoção.
 */
const DEMOTE = 'demote';

const nomeDa = (v) => (v.kind === DEMOTE ? 'rebaixamento' : 'promoção');

/** Para onde vai o rebaixado, em texto: o cargo, ou Recrutador (`to` nulo). */
const destino = (v) => (v.to ? `<@&${STEP_BY_KEY.get(v.to).role}>` : `**${RANK_LABEL.recruiter}**`);
const destinoLabel = (to) => STEP_BY_KEY.get(to)?.label ?? RANK_LABEL.recruiter;

/**
 * Quem vota nesta votação: os Chefes (Staff), menos o alvo — ninguém vota no
 * próprio rebaixamento. Este número é o denominador do "todos votaram".
 */
async function eleitores(guild, v) {
  if (!guild) return 0;
  const n = await eligibleVoterCount(guild);
  const alvo = guild.members.cache.get(v.discordId);
  return alvo && canVote(alvo) ? n - 1 : n;
}

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
  const corpo =
    v.kind === DEMOTE
      ? `<@${v.discordId}> perde <@&${step.role}> e volta a ${destino(v)}.`
      : `<@${v.discordId}> tem **${trackOf(step).unidade(v.reached)}** e pode subir a <@&${step.role}>.`;
  const motivo = v.reason ? `\n**Motivo:** ${v.reason}` : '';
  return {
    title: `${v.kind === DEMOTE ? 'Rebaixamento' : 'Promoção'} — ${v.username}`,
    description: `${aberta}${corpo}${motivo}${fundador}`,
    color: v.kind === DEMOTE ? 0xe67e22 : 0xf1c40f,
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
    content: `<@&${ROLE.chefeStaff}> votação de ${nomeDa(v)}.`,
    embeds: [voteEmbed(v, eligibleCount)],
    components: [voteButtons(v._id.toString())],
    allowedMentions: ping ? { roles: [ROLE.chefeStaff] } : { parse: [] },
  };
}

/**
 * Abre a votação dos Chefes (Staff) no canal deles. Serve à automática (5.000
 * pontos), à aberta por um Chefe (`openedBy`) e ao rebaixamento (`demote`).
 *
 * A mensagem sai ANTES do registro, com o id gerado aqui: votação aberta sem
 * mensagem seria reenviada pelo job de reenvio, que roda em paralelo, e o canal
 * ganharia duas. Se a mensagem não sair, nada é gravado.
 *
 * @param {{to: object|null} | null} [args.demote]  `step` é o cargo que sai, `to` o que entra (null = Recrutador)
 * @param {string|null} [args.reason]  o motivo de quem abriu, opcional
 * @returns {Promise<boolean>} se abriu
 */
async function openVote(client, guild, { member, uuid, nome, step, valor, openedBy = null, demote = null, reason = null }) {
  const canal = await client.channels.fetch(CH_CHEFES).catch(() => null);
  if (!canal) {
    log.warn('Canal dos Chefes indisponível; votação não aberta.');
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
    ...(demote ? { kind: DEMOTE, to: demote.to?.key ?? null } : { stat: track.stat, reached: valor }),
    ...(reason ? { reason } : {}),
    openedBy,
    status: 'open',
    votes: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + hours * 3_600_000),
    channelId: canal.id,
  };

  const eligibleCount = await eleitores(guild, doc);
  const msg = await canal.send(votePayload(doc, eligibleCount, true)).catch((e) => {
    log.error(`Falha ao abrir votação de ${nomeDa(doc)}:`, e);
    return null;
  });
  if (!msg) return false;
  const gravou = await collections
    .promotionVotes()
    .insertOne({ ...doc, messageId: msg.id })
    .then(
      () => true,
      (e) => {
        log.error(`Falha ao gravar votação de ${nomeDa(doc)}:`, e);
        return false;
      },
    );
  // Sem registro, os botões não achariam votação nenhuma.
  if (!gravou) {
    await msg.delete().catch(() => {});
    return false;
  }
  const quem = openedBy ? ` por <@${openedBy}>` : '';
  const texto = demote
    ? `🗳️ Votação de rebaixamento aberta${quem}: <@${member.id}> (**${nome}**) de <@&${step.role}> para ${destino(doc)}.`
    : `🗳️ Votação aberta${quem}: <@${member.id}> (**${nome}**) para <@&${step.role}> — ${track.unidade(valor)}.`;
  await audit(client, guild.id, reason ? `${texto} Motivo: ${reason}` : texto);
  return true;
}

/**
 * Por que não dá para abrir outra votação para esta pessoa agora, ou `null`.
 * Uma por pessoa de cada vez: promoção e rebaixamento abertos juntos se
 * desfariam um ao outro.
 */
async function votacaoEmCurso(discordId) {
  const votes = collections.promotionVotes();
  if (await votes.findOne({ discordId, status: 'open' })) return 'Já tem uma votação aberta para essa pessoa.';
  if (await votes.findOne({ discordId, status: 'approved', owner: 'pending' })) {
    return 'Essa pessoa tem uma votação aprovada esperando a confirmação do Fundador.';
  }
  return null;
}

/**
 * /promover: um Chefe (Staff) abre a votação para pôr alguém em qualquer
 * cargo da Staff acima do que ele tem hoje, sem meta de pontos: decide a
 * maioria dos Chefes. Pôr Chefe (Staff) ainda precisa do Fundador.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} guild
 * @param {{alvoId: string, cargo: string, motivo?: string|null, por: import('discord.js').GuildMember}} args
 * @returns {Promise<string>} a resposta para quem abriu
 */
export async function openManualVote(client, guild, { alvoId, cargo, motivo = null, por }) {
  const step = STEP_BY_KEY.get(cargo);
  if (!step || !TRACKS.staff.steps.includes(step)) return 'Cargo inválido.';
  // O nível do comando já exige Chefe; aqui sai quem está Ocioso.
  if (!hasLevel(por, LEVEL.FUNDADOR) && !canVote(por)) return 'Chefe Ocioso não abre votação.';

  const link = await collections.members().findOne({ discordId: alvoId });
  if (!link) return 'Essa pessoa não tem registro.';
  if (!link.inGuild) return 'Essa pessoa não está na guilda.';
  const member = await guild.members.fetch({ user: alvoId, force: true }).catch(() => null);
  if (!member) return 'Essa pessoa não está no Discord.';
  if (hasLevel(member, LEVEL.FUNDADOR)) return 'O Fundador não entra em votação.';

  const track = trackOf(step);
  const topo = track.steps.find((s) => member.roles.cache.has(s.role));
  if (topo && track.steps.indexOf(topo) <= track.steps.indexOf(step)) {
    return `Essa pessoa já é **${topo.label}**. Para descer, use /rebaixar.`;
  }

  const stats = await collections.guildStats().findOne({ uuid: link.uuid });
  const valor = Number(stats?.[track.stat] ?? 0);

  const emCurso = await votacaoEmCurso(alvoId);
  if (emCurso) return emCurso;

  const abriu = await openVote(client, guild, {
    member,
    uuid: link.uuid,
    nome: link.username,
    step,
    valor,
    openedBy: por.id,
    reason: motivo,
  });
  return abriu ? `Votação aberta em <#${CH_CHEFES}>.` : 'Não consegui abrir a votação: o canal dos Chefes está acessível?';
}

/** Valor do /rebaixar para "sai da Staff": o destino nulo. */
export const RECRUTADOR = 'recrutador';

/**
 * /rebaixar: um Chefe (Staff) abre a votação para descer alguém a qualquer
 * cargo da Staff abaixo do que ele tem hoje, ou a Recrutador (fora da Staff).
 * Mesmo voto e mesmo prazo da promoção; tirar um Chefe (Staff) precisa da
 * confirmação do Fundador, como pôr. O que a pessoa perde não volta sozinho
 * pela trilha (ver cargosTravados).
 *
 * Não pede registro nem guilda: quem está Ocioso também pode ser rebaixado.
 *
 * @param {{alvoId: string, cargo: string, motivo?: string|null, por: import('discord.js').GuildMember}} args
 *   `cargo`: chave de `steps` da trilha Staff, ou RECRUTADOR
 * @returns {Promise<string>} a resposta para quem abriu
 */
export async function openDemoteVote(client, guild, { alvoId, cargo, motivo = null, por }) {
  const para = cargo === RECRUTADOR ? null : STEP_BY_KEY.get(cargo);
  if (para === undefined || (para && !TRACKS.staff.steps.includes(para))) return 'Cargo inválido.';
  if (!hasLevel(por, LEVEL.FUNDADOR) && !canVote(por)) return 'Chefe Ocioso não abre votação.';
  if (alvoId === por.id) return 'Você não abre votação de rebaixamento para si mesmo.';

  const member = await guild.members.fetch({ user: alvoId, force: true }).catch(() => null);
  if (!member) return 'Essa pessoa não está no Discord.';
  if (hasLevel(member, LEVEL.FUNDADOR)) return 'O Fundador não é rebaixado por votação.';

  const { steps } = TRACKS.staff;
  const de = steps.find((s) => member.roles.cache.has(s.role));
  if (!de) return 'Essa pessoa não tem cargo na Staff para perder.';
  if (para && steps.indexOf(para) <= steps.indexOf(de)) {
    return `Essa pessoa é **${de.label}**: o rebaixamento tem que ser para um cargo abaixo. Para subir, use /promover.`;
  }

  const emCurso = await votacaoEmCurso(alvoId);
  if (emCurso) return emCurso;

  const link = await collections.members().findOne({ discordId: alvoId });
  const abriu = await openVote(client, guild, {
    member,
    uuid: link?.uuid ?? null,
    nome: link?.username ?? member.displayName,
    step: de,
    openedBy: por.id,
    demote: { to: para },
    reason: motivo,
  });
  return abriu
    ? `Votação de rebaixamento aberta em <#${CH_CHEFES}>: **${de.label}** → **${destinoLabel(para?.key)}**.`
    : 'Não consegui abrir a votação: o canal dos Chefes está acessível?';
}

/** Troca o resultado mostrado na mensagem da votação. Some calado se ela sumiu. */
async function mostrarResultado(client, v, texto, cor) {
  try {
    const canal = await client.channels.fetch(v.channelId);
    const msg = await canal.messages.fetch(v.messageId);
    const guild = await client.guilds.fetch(v.guildDiscordId).catch(() => null);
    const embed = voteEmbed(v, await eleitores(guild, v));
    embed.color = cor;
    embed.fields.push({ name: 'Resultado', value: texto });
    await msg.edit({ embeds: [embed], components: [voteButtons(v._id.toString(), true)] });
  } catch (e) {
    log.error(`Falha ao editar mensagem da votação de ${nomeDa(v)}:`, e);
  }
}

/**
 * Aplica o resultado aprovado a quem está no Discord. Promoção é anunciada no
 * canal da trilha; rebaixamento fica só na auditoria — não é notícia para a
 * guilda. Sem conseguir, deixa sem `appliedAt`, e o reparo do roleSync tenta
 * de novo.
 *
 * @param {(member, step, track) => string} anuncio  o texto do anúncio da promoção
 */
async function concluir(client, guild, v, anuncio) {
  const step = STEP_BY_KEY.get(v.role);
  const track = trackOf(step);
  const rebaixa = v.kind === DEMOTE;
  // `force`: o cache pode estar atrasado, e é dele que sai o que tirar.
  const member = guild ? await guild.members.fetch({ user: v.discordId, force: true }).catch(() => null) : null;
  if (!member) {
    const fica = rebaixa ? `o rebaixamento de <@&${step.role}>` : `<@&${step.role}>`;
    await audit(client, v.guildDiscordId, `⚠️ **${v.username}** não está no Discord — ${fica} fica para quando voltar.`);
    return;
  }
  const res = await aplicarDecisao(member, new Set(member.roles.cache.keys()), v, rebaixa ? 'Rebaixamento aprovado' : 'Promoção aprovada');
  if (res === 'falhou') {
    const acao = rebaixa ? `rebaixar <@${member.id}> de <@&${step.role}>` : `dar <@&${step.role}> a <@${member.id}>`;
    await audit(client, v.guildDiscordId, `⚠️ Não consegui ${acao} — o cargo do bot está abaixo?`);
    return;
  }
  await collections.promotionVotes().updateOne({ _id: v._id }, { $set: { appliedAt: new Date() } });
  if (res !== 'aplicado') return;
  if (rebaixa) {
    await audit(client, v.guildDiscordId, `⬇️ <@${member.id}> perdeu <@&${step.role}> e voltou a ${destino(v)}.`);
  } else {
    await anunciar(client, track, [{ userId: member.id, texto: anuncio(member, step, track) }]);
  }
}

/**
 * "promoção de **Fulano** a @Cargo" ou "rebaixamento de **Fulano** de @Cargo
 * para @Outro", para a auditoria. `inicio`: com a primeira letra maiúscula.
 */
function assunto(v, inicio = false) {
  const step = STEP_BY_KEY.get(v.role);
  const texto =
    v.kind === DEMOTE
      ? `rebaixamento de **${v.username}** de <@&${step.role}> para ${destino(v)}`
      : `promoção de **${v.username}** a <@&${step.role}>`;
  return inicio ? texto[0].toUpperCase() + texto.slice(1) : texto;
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
  const eligibleCount = await eleitores(guild, v);
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
  const a = v.kind === DEMOTE ? 'o' : 'a';
  await audit(client, v.guildDiscordId, `${assunto(v, true)}: ${result === 'approved' ? `✅ aprovad${a}` : `❌ reprovad${a}`} (${cause}).`);
  if (result !== 'approved') return result;

  if (doFundador) {
    await pedirFundador(client, guild, v);
    return result;
  }
  await concluir(
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
  const rebaixa = v.kind === DEMOTE;
  const aprovado = rebaixa
    ? `O rebaixamento de <@${v.discordId}> (**${v.username}**) de **${step.label}** para **${destinoLabel(v.to)}** ` +
      `foi aprovado pelos Chefes (Staff), ${approve} a ${reject}.`
    : `<@${v.discordId}> (**${v.username}**) foi aprovado pelos Chefes (Staff) para **${step.label}**, ${approve} a ${reject}.`;
  const motivo = v.reason ? `\n**Motivo:** ${v.reason}\n` : ' ';
  const texto = await plainMentions(client, guild, `${aprovado}${motivo}Só vale depois da sua confirmação.`);
  const fim = decisao === 'confirm' ? '✅ Confirmada' : decisao === 'decline' ? '❌ Recusada' : null;
  return {
    embeds: [
      {
        title: rebaixa ? `🛡️ Rebaixamento de ${step.label}` : `🛡️ Promoção a ${step.label}`,
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
 * Pôr ou tirar Chefe (Staff) só vale com o clique do Fundador: DM a cada um. Se
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
    `📨 ${assunto(v, true)} aguardando o Fundador` +
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
  if (!fundador) return interaction.reply({ content: 'Só o Fundador confirma pôr ou tirar Chefe (Staff).', ephemeral: true });

  const agora = new Date();
  const $set = { owner: decisao === 'confirm' ? 'confirmed' : 'declined', ownerBy: interaction.user.id, ownerAt: agora };
  if (decisao === 'confirm') $set.settledAt = agora;
  // Condicional: com mais de um Fundador, vale o primeiro clique.
  const v = await collections
    .promotionVotes()
    .findOneAndUpdate({ _id: v0._id, status: 'approved', owner: 'pending' }, { $set }, { returnDocument: 'after' });
  if (!v) return interaction.reply({ content: 'Isto já foi decidido.', ephemeral: true });

  await interaction.update(await ownerPayload(client, guild, v, decisao));
  await mostrarResultado(
    client,
    v,
    decisao === 'confirm' ? '✅ Aprovada e confirmada pelo Fundador' : '❌ Aprovada, mas recusada pelo Fundador',
    decisao === 'confirm' ? 0x2ecc71 : 0xe74c3c,
  );
  await audit(
    client,
    v.guildDiscordId,
    `${decisao === 'confirm' ? '✅' : '❌'} <@${interaction.user.id}> ${decisao === 'confirm' ? 'confirmou' : 'recusou'} o ${assunto(v)}.`,
  );
  if (decisao !== 'confirm') return;
  await concluir(
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
    return interaction.reply({ content: 'Só os Chefes (Staff) votam promoção e rebaixamento.', ephemeral: true });
  }

  // Um voto por pessoa, numa operação só: tira o voto anterior deste Chefe e
  // põe o novo no MESMO update. Ler, mudar e regravar a lista perderia o voto
  // de quem clicasse no mesmo instante, e dois cliques rápidos da mesma pessoa
  // podiam deixá-la com dois votos. O alvo fica de fora do filtro: um Chefe não
  // vota no próprio rebaixamento.
  const voter = interaction.user.id;
  const v = await collections.promotionVotes().findOneAndUpdate(
    { _id: new ObjectId(id), status: 'open', discordId: { $ne: voter } },
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
  if (!v) {
    const propria = await collections.promotionVotes().findOne({ _id: new ObjectId(id), discordId: voter });
    const content = propria ? 'Você não vota na votação sobre você.' : 'Esta votação já foi encerrada.';
    return interaction.reply({ content, ephemeral: true });
  }

  const eligibleCount = await eleitores(interaction.guild, v);
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
    const eligibleCount = () => eleitores(guild, v);

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
      log.error(`Falha ao reenviar votação de ${nomeDa(v)}:`, e);
      return null;
    });
    if (!msg) continue;
    await collections
      .promotionVotes()
      .updateOne({ _id: v._id }, { $set: { messageId: msg.id, channelId: canal.id } });
    await audit(client, v.guildDiscordId, `🔁 A votação de ${nomeDa(v)} de **${v.username}** foi apagada e reenviada, com os votos que já tinha.`);
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
