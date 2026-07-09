import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

// Cargos da guilda que podem votar (Owner + Chiefs).
const VOTE_ROLES = ['owner', 'chief'];

export async function eligibleVoterCount() {
  return collections.members().countDocuments({ guildRank: { $in: VOTE_ROLES } });
}

export async function isEligibleVoter(discordId) {
  const m = await collections.members().findOne({ discordId });
  return !!m && VOTE_ROLES.includes(m.guildRank);
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

async function pingRecruiters(client, cfg, app) {
  const channelId = cfg.channels?.recruiters;
  if (!channelId) {
    log.warn('Candidatura aprovada, mas canal "recruiters" não está configurado.');
    return;
  }
  const roleId = cfg.roles?.recruiters;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`apply:invited:${app._id}`)
      .setLabel('Convidado ✅')
      .setStyle(ButtonStyle.Success),
  );

  await channel.send({
    content: roleId ? `<@&${roleId}>` : '',
    embeds: [
      {
        title: 'Novo recruta aprovado!',
        description: `Convide **${app.username}** para a guilda:\n\`\`\`\n/guild invite ${app.username}\n\`\`\``,
        color: 0x2ecc71,
      },
    ],
    components: [row],
    allowedMentions: { roles: roleId ? [roleId] : [] },
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
  const eligibleCount = await eligibleVoterCount();
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

  if (result === 'approved') await pingRecruiters(client, cfg, app);
  return result;
}
