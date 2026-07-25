import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

// Fallback: ranks DA GUILDA que podem votar, usado só se `voterRoles` não estiver
// configurado. O caminho normal é por cargo do Discord.
const FALLBACK_GUILD_RANKS = ['owner', 'chief'];

async function voterRoleIds(guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  const raw = cfg.params?.voterRoles;
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

// Quantos podem votar. Recebe a Guild do Discord porque contar cargo exige o
// cache de membros — o rank do jogo vinha do banco, o cargo não.
export async function eligibleVoterCount(discordGuild) {
  const ids = await voterRoleIds(discordGuild.id);
  if (!ids.length) {
    return collections.members().countDocuments({ guildRank: { $in: FALLBACK_GUILD_RANKS } });
  }
  await discordGuild.members.fetch().catch(() => {});
  return discordGuild.members.cache.filter(
    (m) => !m.user.bot && ids.some((id) => m.roles.cache.has(id)),
  ).size;
}

export async function isEligibleVoter(member) {
  const ids = await voterRoleIds(member.guild.id);
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
