import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

// Fallback: ranks DA GUILDA que podem votar, usado só se `voterRoles` não estiver
// configurado. O caminho normal é por cargo do Discord.
const FALLBACK_GUILD_RANKS = ['owner', 'chief'];

// CICLO DE VIDA DE UMA CANDIDATURA
//
//   open → approved → invited → joined     caminho feliz
//        ↘ rejected                        reprovada na votação
//                    ↘ dropped             tirada da fila pela staff
//
// `approved` e `invited` são os DOIS estados em que a pessoa está na fila de
// entrada: passou na votação e ainda não apareceu no jogo. Todo o resto é
// terminal.
//
// `joined` existe porque sem ele a fila não fecha nunca. O critério antigo era
// "aprovado e fora do roster agora", e isso trazia de volta quem entrou e depois
// foi expulso por inatividade — a pessoa cumpriu a fila meses atrás e reaparecia
// como se nunca tivesse entrado.
//
// Só o roleSync escreve `joined`, e de propósito: entrar na guilda é fato
// observável no roster, não declaração. Um botão de "já entrou" no painel seria
// uma segunda fonte de verdade para a mesma pergunta — e a pior das duas, porque
// depende de alguém lembrar de clicar.
export const QUEUE_STATUS = Object.freeze(['approved', 'invited']);

const oid = (id) => (typeof id === 'string' ? new ObjectId(id) : id);

/**
 * A fila de entrada, em ordem de chegada (= ordem de aprovação).
 * @returns {Promise<object[]>}
 */
export function queueApplications() {
  return collections
    .applications()
    .find({ status: { $in: QUEUE_STATUS }, decidedAt: { $ne: null } })
    .sort({ decidedAt: 1 })
    .toArray();
}

/**
 * Fecha a candidatura de quem JÁ ESTÁ na guilda.
 *
 * Chamado com o roster inteiro a cada ciclo do roleSync, e não só na transição
 * de entrada: assim vale também para quem já estava dentro antes deste código
 * existir, sem precisar de migração à parte. Depois da primeira passada não casa
 * mais nada, então o custo some sozinho.
 *
 * @param {string[]} uuids  uuids que estão no roster agora
 * @returns {Promise<number>} quantas candidaturas foram fechadas
 */
export async function closeJoinedApplications(uuids) {
  if (!uuids?.length) return 0;
  const res = await collections.applications().updateMany(
    { uuid: { $in: [...uuids] }, status: { $in: QUEUE_STATUS } },
    { $set: { status: 'joined', joinedAt: new Date() } },
  );
  return res.modifiedCount;
}

/**
 * Marca que o convite foi enviado. `at` aceita data passada, para a staff
 * registrar convite que já tinha mandado antes de o bot acompanhar isso.
 */
export async function markInvited(appId, { at = new Date(), by = null } = {}) {
  const res = await collections.applications().findOneAndUpdate(
    { _id: oid(appId) },
    { $set: { status: 'invited', invitedAt: at, invitedBy: by } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

/** Volta para "aprovado, sem convite" — desfaz um convite marcado por engano. */
export async function unmarkInvited(appId) {
  const res = await collections.applications().findOneAndUpdate(
    { _id: oid(appId) },
    { $set: { status: 'approved' }, $unset: { invitedAt: 1, invitedBy: 1 } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

/**
 * Tira da fila sem ter entrado: desistiu, sumiu, ou a staff resolveu de outro
 * jeito. Fica gravado quem tirou — a fila é decisão de staff e some da vista de
 * todo mundo depois disso.
 */
export async function dropFromQueue(appId, by = null) {
  const res = await collections.applications().findOneAndUpdate(
    { _id: oid(appId) },
    { $set: { status: 'dropped', droppedAt: new Date(), droppedBy: by } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

/**
 * Põe alguém na fila sem candidatura no bot.
 *
 * Existe para o caso real de a aprovação ter acontecido fora daqui — combinada
 * na call, aprovada antes de o bot existir. `decidedAt` define o lugar na fila,
 * então aceitar uma data passada é o que permite encaixar a pessoa na posição
 * certa em vez de jogá-la para o fim.
 */
export async function addToQueue({ uuid, username, discordId = null, decidedAt = new Date(), by = null }) {
  const existente = await collections
    .applications()
    .findOne({ uuid, status: { $in: QUEUE_STATUS } });
  if (existente) return { app: existente, created: false };

  const doc = {
    memberDiscordId: discordId,
    uuid,
    username,
    status: 'approved',
    createdAt: new Date(),
    decidedAt,
    decidedBy: by,
    votes: [],
    manual: true,
  };
  const { insertedId } = await collections.applications().insertOne(doc);
  return { app: { ...doc, _id: insertedId }, created: true };
}

/**
 * Quem vota: os cargos que dão o direito, e o cargo que o tira.
 *
 * O OCIOSO tira. O cargo de liderança dele é resquício de quando estava na
 * guilda — rank é manual e ninguém o remove quando a pessoa sai —, e quem não
 * está na guilda não decide quem entra nela.
 *
 * Isso só faz diferença no caminho por CARGO. No fallback por rank do jogo o
 * ocioso já estava de fora sem ninguém fazer nada: `guildRank` vira null quando
 * a pessoa sai do roster, e null não está em FALLBACK_GUILD_RANKS.
 */
async function voterConfig(guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  const raw = cfg.params?.voterRoles;
  return {
    ids: Array.isArray(raw) ? raw.filter(Boolean) : [],
    idleId: cfg.roles?.idle ?? null,
  };
}

// Quantos podem votar. Recebe a Guild do Discord porque contar cargo exige o
// cache de membros — o rank do jogo vinha do banco, o cargo não.
export async function eligibleVoterCount(discordGuild) {
  const { ids, idleId } = await voterConfig(discordGuild.id);
  if (!ids.length) {
    return collections.members().countDocuments({ guildRank: { $in: FALLBACK_GUILD_RANKS } });
  }
  await discordGuild.members.fetch().catch(() => {});
  return discordGuild.members.cache.filter(
    (m) =>
      !m.user.bot &&
      ids.some((id) => m.roles.cache.has(id)) &&
      // Fora da conta, e não só impedido de clicar: este número é o
      // DENOMINADOR da votação. Com o ocioso somando aqui, a regra
      // `effective` passaria a exigir um voto que nunca viria, e toda
      // candidatura ficaria presa até estourar o prazo.
      !(idleId && m.roles.cache.has(idleId)),
  ).size;
}

export async function isEligibleVoter(member) {
  const { ids, idleId } = await voterConfig(member.guild.id);
  // Antes de qualquer outra checagem: o ocioso não vota, tenha o cargo que tiver.
  if (idleId && member.roles.cache.has(idleId)) return false;

  if (ids.length) return ids.some((id) => member.roles.cache.has(id));
  const m = await collections.members().findOne({ discordId: member.id });
  return !!m && FALLBACK_GUILD_RANKS.includes(m.guildRank);
}

export function tally(votes = []) {
  let approve = 0;
  let reject = 0;
  let abstain = 0;
  for (const v of votes) {
    if (v.choice === 'approve') approve++;
    else if (v.choice === 'reject') reject++;
    else if (v.choice === 'abstain') abstain++;
  }
  return { approve, reject, abstain };
}

// Decide o resultado conforme a regra configurada (design.md §6).
export function decide(votes, rule, eligibleCount) {
  const { approve, reject } = tally(votes);
  if (rule === 'total') {
    // > 50% do total de eleitores elegíveis; abstenção pesa contra aprovação.
    return approve * 2 > eligibleCount ? 'approved' : 'rejected';
  }
  // 'effective' (padrão): > 50% dos votos efetivos (aprovar + reprovar).
  // Abstenções ficam fora do cálculo. Empate = reprovado.
  return approve > reject ? 'approved' : 'rejected';
}

export function labelFor(choice) {
  if (choice === 'approve') return 'Aprovar';
  if (choice === 'reject') return 'Reprovar';
  return 'Abster';
}

export function voteButtons(appId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply:vote:${appId}:approve`)
      .setLabel('Aprovar')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`apply:vote:${appId}:reject`)
      .setLabel('Reprovar')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`apply:vote:${appId}:abstain`)
      .setLabel('Abster')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

// O contador é público, mas o voto é anônimo: mostramos só os totais, nunca
// quem votou o quê. O canal é o de recrutamento, à vista de todos.
export function voteEmbed(app, eligibleCount) {
  const { approve, reject, abstain } = tally(app.votes);
  const expiresUnix = Math.floor(new Date(app.expiresAt).getTime() / 1000);
  return {
    title: `Candidatura — ${app.username}`,
    description: `<@${app.memberDiscordId}> quer entrar na guilda.`,
    color: 0x3498db,
    fields: [
      { name: 'Aprovar', value: String(approve), inline: true },
      { name: 'Reprovar', value: String(reject), inline: true },
      { name: 'Abster', value: String(abstain), inline: true },
      { name: 'Eleitores elegíveis', value: String(eligibleCount), inline: true },
      { name: 'Encerra', value: `<t:${expiresUnix}:R>`, inline: true },
    ],
    footer: { text: `ID: ${app._id}` },
  };
}

/**
 * Anuncia o recruta aprovado no canal de recrutamento, com o comando de convite
 * pronto para copiar. Não pinga cargo nenhum: quem acompanha o canal já está lá.
 * @param {import('discord.js').Client} client
 * @param {import('../config/guildConfig.js').GuildConfig} cfg
 * @param {object} app  documento da candidatura
 */
async function announceApproved(client, cfg, app) {
  const channelId = cfg.channels?.recruiters;
  if (!channelId) {
    log.warn('Candidatura aprovada, mas canal "recruiters" não está configurado.');
    return;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply:invited:${app._id}`)
      .setLabel('Convidado')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
  );

  await channel.send({
    embeds: [
      {
        title: '🎉 Novo recruta aprovado!',
        description: `Convide **${app.username}** para a guilda:\n\`\`\`\n/guild invite ${app.username}\n\`\`\``,
        color: 0x2ecc71,
      },
    ],
    components: [row],
    allowedMentions: { parse: [] },
  });
}

// Encerra a votação, edita a mensagem e (se aprovado) chama os recrutadores.
export async function finalizeApplication(client, appId, cause = 'deadline') {
  const apps = collections.applications();
  const _id = typeof appId === 'string' ? new ObjectId(appId) : appId;
  const app = await apps.findOne({ _id });
  if (!app || app.status !== 'open') return null;

  const cfg = await getConfig(app.guildDiscordId);
  const rule = cfg.params?.voteRule || 'effective';
  const discordGuild = await client.guilds.fetch(app.guildDiscordId).catch(() => null);
  const eligibleCount = discordGuild ? await eligibleVoterCount(discordGuild) : 0;
  const result = decide(app.votes, rule, eligibleCount);

  await apps.updateOne(
    { _id },
    { $set: { status: result, decidedAt: new Date(), decidedBy: cause } },
  );
  app.status = result;

  try {
    const channel = await client.channels.fetch(app.channelId);
    const msg = await channel.messages.fetch(app.messageId);
    const embed = voteEmbed(app, eligibleCount);
    embed.color = result === 'approved' ? 0x2ecc71 : 0xe74c3c;
    embed.fields.push({
      name: 'Resultado',
      value: result === 'approved' ? '✅ Aprovado' : '❌ Reprovado',
    });
    await msg.edit({ embeds: [embed], components: [voteButtons(_id.toString(), true)] });
  } catch (e) {
    log.error('Falha ao editar mensagem de votação:', e);
  }

  if (result === 'rejected') {
    // Registra a reprovação para aplicar o cooldown de reaplicação.
    await collections
      .members()
      .updateOne({ discordId: app.memberDiscordId }, { $set: { lastRejectedAt: new Date() } });
  }

  await audit(
    client,
    app.guildDiscordId,
    `Candidatura de **${app.username}**: ${result === 'approved' ? '✅ aprovada' : '❌ reprovada'} (${cause}).`,
  );

  if (result === 'approved') await announceApproved(client, cfg, app);
  return result;
}
