import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { canVote } from './permissions.js';
import { eligibleVoterCount, tally, decide, labelFor } from './applications.js';
import { rankWeight } from './guildData.js';
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
});

const CH_CHEFES = '1332548770940063776'; // canal dos Chefes (Staff)

const fmt = (n) => Number(n).toLocaleString('pt-BR');

/**
 * Cada trilha, do cargo mais alto para o mais baixo. `auto`: o bot dá sozinho
 * ao chegar lá. `vote`: o bot abre a votação dos Chefes (Staff). Sem nenhum dos
 * dois, o cargo é manual. `rank` é o rank do jogo que o cargo representa.
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
      { key: 'chefeStaff', role: ROLE.chefeStaff, label: 'Chefe (Staff)', rank: 'chief' },
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

  const anuncios = new Map(Object.values(TRACKS).map((t) => [t, []]));
  const ajustes = [];
  for (const { member, uuid, nome } of alvos) {
    const s = statsByUuid.get(uuid) ?? {};
    for (const track of Object.values(TRACKS)) {
      const valor = Number(s[track.stat] ?? 0);
      const plano = planTrack(track, member.roles.cache, valor);

      const dar = [plano.give && STEP_BY_KEY.get(plano.give).role, plano.team && track.team].filter(Boolean);
      const tirar = plano.remove.map((k) => STEP_BY_KEY.get(k).role);
      let ok = true;
      if (dar.length) ok = await member.roles.add(dar, 'Trilha de cargo').then(() => true, () => false);
      if (ok && tirar.length) await member.roles.remove(tirar, 'Um cargo por trilha').catch(() => {});

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

      if (plano.vote) await openPromotionVote(client, guild, { member, uuid, nome, step: STEP_BY_KEY.get(plano.vote), valor, track });
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

/** Prefixo dos botões. O /apply os adota: é ele quem cuida de votação. */
export const PROMO_PREFIX = 'promo:';

function voteButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    ['approve', 'reject', 'abstain'].map((choice) =>
      new ButtonBuilder()
        .setCustomId(`${PROMO_PREFIX}vote:${id}:${choice}`)
        .setLabel(labelFor(choice))
        .setStyle(choice === 'approve' ? ButtonStyle.Success : choice === 'reject' ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );
}

// Mesmo formato da candidatura: totais à vista, voto anônimo.
function voteEmbed(v, eligibleCount) {
  const { approve, reject, abstain } = tally(v.votes);
  const step = STEP_BY_KEY.get(v.role);
  return {
    title: `Promoção — ${v.username}`,
    description: `<@${v.discordId}> chegou a **${trackOf(step).unidade(v.reached)}** e pode subir a <@&${step.role}>.`,
    color: 0xf1c40f,
    fields: [
      { name: 'Aprovar', value: String(approve), inline: true },
      { name: 'Reprovar', value: String(reject), inline: true },
      { name: 'Abster', value: String(abstain), inline: true },
      { name: 'Eleitores elegíveis', value: String(eligibleCount), inline: true },
      { name: 'Encerra', value: `<t:${Math.floor(new Date(v.expiresAt).getTime() / 1000)}:R>`, inline: true },
    ],
    footer: { text: `ID: ${v._id}` },
  };
}

/**
 * Abre a votação dos Chefes (Staff) para o próximo cargo da trilha.
 *
 * Uma votação por pessoa e cargo, para sempre: reprovada, o bot não reabre
 * sozinho a cada ciclo. Se a mensagem não sair, o registro é desfeito e o
 * próximo ciclo tenta de novo — votação sem mensagem expiraria sem voto e
 * reprovaria a pessoa sem ninguém ter visto.
 */
async function openPromotionVote(client, guild, { member, uuid, nome, step, valor, track }) {
  const votes = collections.promotionVotes();
  if (await votes.findOne({ discordId: member.id, role: step.key })) return;

  const canal = await client.channels.fetch(CH_CHEFES).catch(() => null);
  if (!canal) {
    log.warn('Canal dos Chefes indisponível; votação de promoção fica para o próximo ciclo.');
    return;
  }

  const cfg = await getConfig(guild.id);
  const hours = Number(cfg.params?.voteWindowHours) || 24;
  const now = new Date();
  const doc = {
    guildDiscordId: guild.id,
    discordId: member.id,
    uuid,
    username: nome,
    role: step.key,
    stat: track.stat,
    reached: valor,
    status: 'open',
    votes: [],
    createdAt: now,
    expiresAt: new Date(now.getTime() + hours * 3_600_000),
    channelId: canal.id,
  };
  const { insertedId } = await votes.insertOne(doc);
  doc._id = insertedId;

  const eligibleCount = await eligibleVoterCount(guild);
  const msg = await canal
    .send({
      content: `<@&${ROLE.chefeStaff}> nova votação de promoção.`,
      embeds: [voteEmbed(doc, eligibleCount)],
      components: [voteButtons(insertedId.toString())],
      allowedMentions: { roles: [ROLE.chefeStaff] },
    })
    .catch((e) => {
      log.error('Falha ao abrir votação de promoção:', e);
      return null;
    });
  if (!msg) {
    await votes.deleteOne({ _id: insertedId });
    return;
  }
  await votes.updateOne({ _id: insertedId }, { $set: { messageId: msg.id } });
  await audit(client, guild.id, `🗳️ Votação aberta: <@${member.id}> (**${nome}**) para <@&${step.role}> — ${track.unidade(valor)}.`);
}

/**
 * Encerra a votação e, aprovada, troca o cargo.
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

  const { modifiedCount } = await votes.updateOne(
    { _id, status: 'open' },
    { $set: { status: result, decidedAt: new Date(), decidedBy: cause } },
  );
  if (!modifiedCount) return null;
  v.status = result;

  try {
    const canal = await client.channels.fetch(v.channelId);
    const msg = await canal.messages.fetch(v.messageId);
    const embed = voteEmbed(v, eligibleCount);
    embed.color = result === 'approved' ? 0x2ecc71 : 0xe74c3c;
    embed.fields.push({ name: 'Resultado', value: result === 'approved' ? '✅ Aprovada' : '❌ Reprovada' });
    await msg.edit({ embeds: [embed], components: [voteButtons(_id.toString(), true)] });
  } catch (e) {
    log.error('Falha ao editar mensagem da votação de promoção:', e);
  }

  const step = STEP_BY_KEY.get(v.role);
  const track = trackOf(step);
  await audit(
    client,
    v.guildDiscordId,
    `Promoção de **${v.username}** a <@&${step.role}>: ${result === 'approved' ? '✅ aprovada' : '❌ reprovada'} (${cause}).`,
  );
  if (result !== 'approved') return result;

  const member = guild ? await guild.members.fetch(v.discordId).catch(() => null) : null;
  if (!member) {
    await audit(client, v.guildDiscordId, `⚠️ **${v.username}** não está mais no Discord — o cargo <@&${step.role}> não foi aplicado.`);
    return result;
  }
  // Recalcula o plano como se a pessoa tivesse o cargo votado: o que estiver
  // abaixo dele na trilha sai, e o cargo de time vem junto se faltar.
  const comVotado = { has: (rid) => rid === step.role || member.roles.cache.has(rid) };
  const plano = planTrack(track, comVotado, 0);
  if (plano.top !== step.key) return result; // já tem um cargo acima: nada a fazer

  const dar = [step.role, plano.team && track.team].filter((rid) => rid && !member.roles.cache.has(rid));
  const ok = await member.roles.add(dar, 'Promoção aprovada pelos Chefes (Staff)').then(() => true, () => false);
  if (!ok) {
    await audit(client, v.guildDiscordId, `⚠️ Não consegui dar <@&${step.role}> a <@${member.id}> — o cargo do bot está abaixo?`);
    return result;
  }
  const tirar = plano.remove.map((k) => STEP_BY_KEY.get(k).role);
  if (tirar.length) await member.roles.remove(tirar, 'Um cargo por trilha').catch(() => {});
  await anunciar(client, track, [
    { userId: member.id, texto: `${track.emoji} <@${member.id}> foi aprovado pelos <@&${ROLE.chefeStaff}> → <@&${step.role}>` },
  ]);
  return result;
}

/** Botões `promo:vote:<id>:<escolha>`. */
export async function handlePromotionVoteButton(interaction) {
  const [, action, id, choice] = interaction.customId.split(':');
  if (action !== 'vote' || !ObjectId.isValid(id) || !['approve', 'reject', 'abstain'].includes(choice)) return;
  if (!canVote(interaction.member)) {
    return interaction.reply({ content: 'Só os Chefes (Staff) votam promoção.', ephemeral: true });
  }

  const votes = collections.promotionVotes();
  const _id = new ObjectId(id);
  const v = await votes.findOne({ _id });
  if (!v || v.status !== 'open') {
    return interaction.reply({ content: 'Esta votação já foi encerrada.', ephemeral: true });
  }

  // Substitui o voto anterior deste eleitor, se houver.
  const lista = (v.votes || []).filter((x) => x.voterDiscordId !== interaction.user.id);
  lista.push({ voterDiscordId: interaction.user.id, choice, at: new Date() });
  await votes.updateOne({ _id }, { $set: { votes: lista } });
  v.votes = lista;

  const eligibleCount = await eligibleVoterCount(interaction.guild);
  await interaction.update({ embeds: [voteEmbed(v, eligibleCount)], components: [voteButtons(id)] });
  await interaction.followUp({ content: `Voto registrado: **${labelFor(choice)}**.`, ephemeral: true });

  const { approve, reject, abstain } = tally(lista);
  if (eligibleCount > 0 && approve + reject + abstain >= eligibleCount) {
    await finalizePromotionVote(interaction.client, id, 'all-voted');
  }
}

/** Fecha as votações de promoção cujo prazo passou. */
export async function runPromotionVoteExpiry(client) {
  const vencidas = await collections
    .promotionVotes()
    .find({ status: 'open', expiresAt: { $lte: new Date() } })
    .toArray();
  for (const v of vencidas) await finalizePromotionVote(client, v._id, 'deadline');
}
