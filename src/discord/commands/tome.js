import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { collections } from '../../db/mongo.js';
import { rankedQueue } from '../../services/tomes.js';
import { getConfig } from '../../config/guildConfig.js';

/** Anuncia no canal de Tomes (junto da fila/painel), não no de auditoria. */
async function announceTome(client, guildDiscordId, content) {
  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.tome;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel) await channel.send({ content, allowedMentions: { parse: [] } });
}

/** Ações abertas a qualquer membro. @type {readonly string[]} */
const BUTTON_ACTIONS = Object.freeze(['join', 'leave', 'queue']);

/**
 * Ranks DA GUILDA que podem entregar um Tome. "Chief ou superior".
 * @type {readonly string[]}
 */
const MANAGER_GUILD_RANKS = Object.freeze(['chief', 'owner']);

/** O menu de seleção do Discord aceita no máximo 25 opções. */
const SELECT_LIMIT = 25;

/**
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
async function isTomeManager(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const linked = await collections.members().findOne({ discordId: interaction.user.id });
  return MANAGER_GUILD_RANKS.includes(linked?.guildRank);
}

/** Remove alguém da fila e registra a entrega. */
async function deliverTo(interaction, uuid) {
  const entry = await collections.tomeQueue().findOne({ uuid });
  if (!entry) return interaction.editReply({ content: 'Essa pessoa não está mais na fila.', components: [] });

  await collections.tomeQueue().deleteOne({ uuid });
  await announceTome(interaction.client, interaction.guildId, `📜 Tome entregue a **${entry.username}** por <@${interaction.user.id}>.`);
  return interaction.editReply({
    content: `Tome entregue a **${entry.username}**. Removido da fila.`,
    components: [],
  });
}

/** Passo 1 do botão "Entregar Tome": escolher quem recebeu. */
async function promptDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Apenas **Chief ou superior** pode entregar Tomes.', ephemeral: true });
  }

  const ranked = await rankedQueue();
  if (!ranked.length) return interaction.reply({ content: 'A fila está vazia.', ephemeral: true });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('tome:delivered')
    .setPlaceholder('Quem recebeu o Tome?')
    .addOptions(
      ranked.slice(0, SELECT_LIMIT).map((r, i) => ({
        label: r.username,
        value: r.uuid,
        description: `${i + 1}º na fila · ${r.points} pts`,
      })),
    );

  return interaction.reply({
    content: 'Selecione quem recebeu. Ele sai da fila na hora.',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/** @param {import('discord.js').Interaction} interaction */
async function joinQueue(interaction) {
  const member = await collections.members().findOne({ discordId: interaction.user.id });
  if (!member) return interaction.editReply('Você precisa se registrar antes (canal de registro).');

  await collections.tomeQueue().updateOne(
    { uuid: member.uuid },
    {
      $set: { uuid: member.uuid, discordId: member.discordId, username: member.username },
      $setOnInsert: { joinedQueueAt: new Date() },
    },
    { upsert: true },
  );

  const ranked = await rankedQueue();
  const pos = ranked.findIndex((r) => r.uuid === member.uuid) + 1;
  return interaction.editReply(
    `Você entrou na fila de Tomes! Posição atual: **${pos}** de ${ranked.length}.\n-# A fila é ordenada por pontos de contribuição, não por ordem de chegada.`,
  );
}

/** @param {import('discord.js').Interaction} interaction */
async function leaveQueue(interaction) {
  const member = await collections.members().findOne({ discordId: interaction.user.id });
  if (!member) return interaction.editReply('Você não está registrado.');
  const res = await collections.tomeQueue().deleteOne({ uuid: member.uuid });
  return interaction.editReply(res.deletedCount ? 'Você saiu da fila de Tomes.' : 'Você não estava na fila.');
}

/** @param {import('discord.js').Interaction} interaction */
async function showQueue(interaction) {
  const ranked = await rankedQueue();
  if (!ranked.length) return interaction.editReply('A fila de Tomes está vazia.');
  const lines = ranked
    .slice(0, 15)
    .map((r, i) => `\`${String(i + 1).padStart(2, ' ')}\` **${r.username}** — ${r.points} pts`);
  return interaction.editReply({
    embeds: [
      {
        title: '📜 Fila de Tomes',
        description: lines.join('\n'),
        color: 0x9b59b6,
        footer: { text: `${ranked.length} na fila · ordenada por pontos de contribuição` },
      },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('tome')
    .setDescription('Fila de Tomes da guilda')
    .addSubcommand((s) => s.setName('join').setDescription('Entra na fila de Tomes'))
    .addSubcommand((s) => s.setName('leave').setDescription('Sai da fila de Tomes'))
    .addSubcommand((s) => s.setName('queue').setDescription('Mostra a fila (ordenada por pontos)'))
    .addSubcommand((s) =>
      s
        .setName('grant')
        .setDescription('(Staff) Concede um Tome e remove da fila')
        .addUserOption((o) => o.setName('user').setDescription('Quem recebeu (padrão: topo da fila)').setRequired(false)),
    )
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('tome:');
  },

  async handleComponent(interaction) {
    const action = interaction.customId.split(':')[1];

    if (action === 'deliver') return promptDelivery(interaction);
    if (action === 'delivered') {
      if (!(await isTomeManager(interaction))) {
        return interaction.update({ content: 'Sem permissão.', components: [] });
      }
      await interaction.deferUpdate();
      return deliverTo(interaction, interaction.values[0]);
    }

    if (!BUTTON_ACTIONS.includes(action)) return;
    await interaction.deferReply({ ephemeral: true });
    if (action === 'join') return joinQueue(interaction);
    if (action === 'leave') return leaveQueue(interaction);
    return showQueue(interaction);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: sub !== 'queue' });

    if (sub === 'join') return joinQueue(interaction);
    if (sub === 'leave') return leaveQueue(interaction);
    if (sub === 'queue') return showQueue(interaction);

    // grant (staff)
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply('Apenas staff pode conceder Tomes.');
    }
    const user = interaction.options.getUser('user');
    let target;
    if (user) {
      const member = await collections.members().findOne({ discordId: user.id });
      if (!member) return interaction.editReply('Esse usuário não está vinculado.');
      target = await collections.tomeQueue().findOne({ uuid: member.uuid });
      if (!target) return interaction.editReply('Esse usuário não está na fila.');
    } else {
      const ranked = await rankedQueue();
      if (!ranked.length) return interaction.editReply('A fila está vazia.');
      target = ranked[0];
    }
    await collections.tomeQueue().deleteOne({ uuid: target.uuid });
    await announceTome(interaction.client, interaction.guildId, `📜 Tome concedido a **${target.username}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Tome concedido a **${target.username}** e removido da fila.`);
  },
};
