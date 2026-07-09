import { SlashCommandBuilder } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import {
  eligibleVoterCount,
  isEligibleVoter,
  tally,
  labelFor,
  voteButtons,
  voteEmbed,
  finalizeApplication,
} from '../../services/applications.js';

async function submitApplication(interaction) {
  const member = await collections.members().findOne({ discordId: interaction.user.id });
  if (!member) {
    return interaction.editReply('Você precisa se vincular primeiro com `/link`.');
  }
  if (member.inGuild) {
    return interaction.editReply('Você já está na guilda.');
  }

  const cfg = await getConfig(interaction.guildId);

  // Cooldown de reaplicação após reprovação.
  const cooldownH = Number(cfg.params?.reapplyCooldownHours) || 0;
  if (member.lastRejectedAt && cooldownH > 0) {
    const until = new Date(member.lastRejectedAt).getTime() + cooldownH * 3_600_000;
    if (Date.now() < until) {
      return interaction.editReply(
        `Você foi reprovado recentemente. Pode tentar de novo <t:${Math.floor(until / 1000)}:R>.`,
      );
    }
  }

  const channelId = cfg.channels?.applications;
  if (!channelId) {
    return interaction.editReply(
      'Canal de candidaturas não configurado. Peça à staff: `/config channel key:applications`.',
    );
  }

  const apps = collections.applications();
  const existing = await apps.findOne({ memberDiscordId: interaction.user.id, status: 'open' });
  if (existing) {
    return interaction.editReply('Você já tem uma candidatura em aberto.');
  }

  const hours = Number(cfg.params?.voteWindowHours) || 24;
  const now = new Date();
  const doc = {
    memberDiscordId: interaction.user.id,
    uuid: member.uuid,
    username: member.username,
    guildDiscordId: interaction.guildId,
    channelId,
    messageId: null,
    status: 'open',
    createdAt: now,
    expiresAt: new Date(now.getTime() + hours * 3_600_000),
    votes: [],
  };
  const { insertedId } = await apps.insertOne(doc);
  doc._id = insertedId;

  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    return interaction.editReply('Não consegui acessar o canal de candidaturas.');
  }
  const eligibleCount = await eligibleVoterCount();
  const msg = await channel.send({
    embeds: [voteEmbed(doc, eligibleCount)],
    components: [voteButtons(insertedId.toString())],
  });
  await apps.updateOne({ _id: insertedId }, { $set: { messageId: msg.id } });

  return interaction.editReply(`Sua candidatura foi enviada! A liderança tem ${hours}h para votar.`);
}

async function applicationStatus(interaction) {
  const app = await collections
    .applications()
    .findOne({ memberDiscordId: interaction.user.id, status: 'open' });
  if (!app) return interaction.editReply('Você não tem candidatura em aberto.');
  const { approve, reject, abstain } = tally(app.votes);
  const eligibleCount = await eligibleVoterCount();
  return interaction.editReply(
    `Sua candidatura está aberta. Votos — Aprovar: **${approve}**, Reprovar: **${reject}**, Abster: **${abstain}** (elegíveis: ${eligibleCount}). Encerra <t:${Math.floor(new Date(app.expiresAt).getTime() / 1000)}:R>.`,
  );
}

async function handleVote(interaction, appId, choice) {
  if (!(await isEligibleVoter(interaction.user.id))) {
    return interaction.reply({
      content: 'Apenas Owner e Chiefs podem votar.',
      ephemeral: true,
    });
  }

  const apps = collections.applications();
  const _id = new ObjectId(appId);
  const app = await apps.findOne({ _id });
  if (!app || app.status !== 'open') {
    return interaction.reply({ content: 'Esta votação já foi encerrada.', ephemeral: true });
  }

  // Substitui o voto anterior deste eleitor, se houver.
  const votes = (app.votes || []).filter((v) => v.voterDiscordId !== interaction.user.id);
  votes.push({ voterDiscordId: interaction.user.id, choice, at: new Date() });
  await apps.updateOne({ _id }, { $set: { votes } });
  app.votes = votes;

  const eligibleCount = await eligibleVoterCount();
  await interaction.update({
    embeds: [voteEmbed(app, eligibleCount)],
    components: [voteButtons(appId)],
  });
  await interaction.followUp({
    content: `Voto registrado: **${labelFor(choice)}**.`,
    ephemeral: true,
  });

  // Encerramento antecipado: todos os elegíveis já votaram.
  const { approve, reject, abstain } = tally(votes);
  if (eligibleCount > 0 && approve + reject + abstain >= eligibleCount) {
    await finalizeApplication(interaction.client, appId, 'all-voted');
  }
}

async function handleInvited(interaction, appId) {
  const apps = collections.applications();
  const _id = new ObjectId(appId);
  const app = await apps.findOne({ _id });
  if (!app) {
    return interaction.reply({ content: 'Candidatura não encontrada.', ephemeral: true });
  }
  await apps.updateOne(
    { _id },
    { $set: { status: 'invited', invitedBy: interaction.user.id, invitedAt: new Date() } },
  );
  const e = interaction.message.embeds[0];
  await interaction.update({
    components: [],
    embeds: [
      {
        title: e?.title ?? 'Recruta',
        description: e?.description ?? '',
        color: 0x95a5a6,
        footer: { text: `Convidado por ${interaction.user.username}` },
      },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('apply')
    .setDescription('Candidatura para entrar na guilda')
    .addSubcommand((s) => s.setName('submit').setDescription('Envia sua candidatura (precisa de /link)'))
    .addSubcommand((s) => s.setName('status').setDescription('Vê o status da sua candidatura aberta'))
    .toJSON(),

  // Roteamento de botões (apply:vote:* e apply:invited:*).
  owns(interaction) {
    return interaction.isButton?.() && interaction.customId.startsWith('apply:');
  },

  async handleComponent(interaction) {
    const [, action, appId, choice] = interaction.customId.split(':');
    if (action === 'vote') return handleVote(interaction, appId, choice);
    if (action === 'invited') return handleInvited(interaction, appId);
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    if (sub === 'status') return applicationStatus(interaction);
    return submitApplication(interaction);
  },
};
