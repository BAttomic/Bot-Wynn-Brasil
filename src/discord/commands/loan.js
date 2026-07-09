import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../../db/mongo.js';
import { audit } from '../../services/audit.js';

function fmtLoan(l) {
  const val = l.type === 'emeralds' ? `${l.amount} esmeraldas` : l.itemDesc;
  const due = `<t:${Math.floor(new Date(l.dueAt).getTime() / 1000)}:R>`;
  return `\`${l._id}\` — <@${l.borrowerDiscordId}>: **${val}** · vence ${due} · *${l.status}*`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('loan')
    .setDescription('Empréstimos da guilda (esmeraldas/itens)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('new')
        .setDescription('Registra um novo empréstimo')
        .addUserOption((o) => o.setName('user').setDescription('Devedor').setRequired(true))
        .addStringOption((o) =>
          o.setName('type').setDescription('Tipo').setRequired(true).addChoices({ name: 'emeralds', value: 'emeralds' }, { name: 'item', value: 'item' }),
        )
        .addIntegerOption((o) => o.setName('days').setDescription('Prazo em dias').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Qtd. de esmeraldas (se emeralds)').setRequired(false))
        .addStringOption((o) => o.setName('item').setDescription('Descrição do item (se item)').setRequired(false)),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('Lista empréstimos em aberto').addUserOption((o) => o.setName('user').setDescription('Filtra por devedor').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('repay').setDescription('Marca como pago').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancela um empréstimo').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const loans = collections.loans();

    if (sub === 'new') {
      const user = interaction.options.getUser('user', true);
      const type = interaction.options.getString('type', true);
      const days = interaction.options.getInteger('days', true);
      const amount = interaction.options.getInteger('amount');
      const item = interaction.options.getString('item');
      if (type === 'emeralds' && !amount) return interaction.editReply('Informe `amount` para empréstimo de esmeraldas.');
      if (type === 'item' && !item) return interaction.editReply('Informe `item` para empréstimo de item.');

      const member = await collections.members().findOne({ discordId: user.id });
      const doc = {
        borrowerDiscordId: user.id,
        borrowerUuid: member?.uuid ?? null,
        type,
        amount: type === 'emeralds' ? amount : null,
        itemDesc: type === 'item' ? item : null,
        createdAt: new Date(),
        dueAt: new Date(Date.now() + days * 86_400_000),
        status: 'open',
        createdBy: interaction.user.id,
        remindersSent: [],
      };
      const { insertedId } = await loans.insertOne(doc);
      audit(interaction.client, interaction.guildId, `💰 Empréstimo registrado para <@${user.id}> (${type}) por <@${interaction.user.id}>.`);
      return interaction.editReply(`Empréstimo registrado. ID: \`${insertedId}\`.`);
    }

    if (sub === 'list') {
      const user = interaction.options.getUser('user');
      const filter = { status: 'open' };
      if (user) filter.borrowerDiscordId = user.id;
      const rows = await loans.find(filter).sort({ dueAt: 1 }).limit(20).toArray();
      if (!rows.length) return interaction.editReply('Nenhum empréstimo em aberto.');
      return interaction.editReply(rows.map(fmtLoan).join('\n'));
    }

    // repay / cancel
    const id = interaction.options.getString('id', true);
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      return interaction.editReply('ID inválido.');
    }
    const status = sub === 'repay' ? 'repaid' : 'cancelled';
    const res = await loans.updateOne({ _id, status: 'open' }, { $set: { status, closedAt: new Date(), closedBy: interaction.user.id } });
    if (!res.matchedCount) return interaction.editReply('Empréstimo não encontrado ou já fechado.');
    audit(interaction.client, interaction.guildId, `💰 Empréstimo \`${id}\` marcado como **${status}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Empréstimo marcado como **${status}**.`);
  },
};
