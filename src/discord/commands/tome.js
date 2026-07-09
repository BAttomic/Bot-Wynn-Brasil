import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { rankedQueue } from '../../services/tomes.js';
import { audit } from '../../services/audit.js';

export default {
  data: new SlashCommandBuilder()
    .setName('tome')
    .setDescription('Fila de Tomes da guilda')
    .addSubcommand((s) => s.setName('join').setDescription('Entra na fila de Tomes'))
    .addSubcommand((s) => s.setName('leave').setDescription('Sai da fila de Tomes'))
    .addSubcommand((s) => s.setName('queue').setDescription('Mostra a fila (ordenada por contribuição)'))
    .addSubcommand((s) =>
      s
        .setName('grant')
        .setDescription('(Staff) Concede um Tome e remove da fila')
        .addUserOption((o) => o.setName('user').setDescription('Quem recebeu (padrão: topo da fila)').setRequired(false)),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: interaction.options.getSubcommand() !== 'queue' });
    const sub = interaction.options.getSubcommand();
    const queue = collections.tomeQueue();

    if (sub === 'join') {
      const member = await collections.members().findOne({ discordId: interaction.user.id });
      if (!member) return interaction.editReply('Você precisa se vincular com `/link`.');
      await queue.updateOne(
        { uuid: member.uuid },
        { $set: { uuid: member.uuid, discordId: member.discordId, username: member.username }, $setOnInsert: { joinedQueueAt: new Date() } },
        { upsert: true },
      );
      return interaction.editReply('Você entrou na fila de Tomes!');
    }

    if (sub === 'leave') {
      const member = await collections.members().findOne({ discordId: interaction.user.id });
      if (!member) return interaction.editReply('Você não está vinculado.');
      await queue.deleteOne({ uuid: member.uuid });
      return interaction.editReply('Você saiu da fila de Tomes.');
    }

    if (sub === 'queue') {
      const ranked = await rankedQueue();
      if (!ranked.length) return interaction.editReply('A fila de Tomes está vazia.');
      const lines = ranked.map((r, i) => `\`${String(i + 1).padStart(2, ' ')}\` **${r.username}** — ${r.points} pts`);
      return interaction.editReply({
        embeds: [{ title: '📜 Fila de Tomes', description: lines.join('\n'), color: 0x9b59b6 }],
      });
    }

    // grant (staff)
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply('Apenas staff pode conceder Tomes.');
    }
    const user = interaction.options.getUser('user');
    let target;
    if (user) {
      const member = await collections.members().findOne({ discordId: user.id });
      if (!member) return interaction.editReply('Esse usuário não está vinculado.');
      target = await queue.findOne({ uuid: member.uuid });
      if (!target) return interaction.editReply('Esse usuário não está na fila.');
    } else {
      const ranked = await rankedQueue();
      if (!ranked.length) return interaction.editReply('A fila está vazia.');
      target = ranked[0];
    }
    await queue.deleteOne({ uuid: target.uuid });
    audit(interaction.client, interaction.guildId, `📜 Tome concedido a **${target.username}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Tome concedido a **${target.username}** e removido da fila.`);
  },
};
