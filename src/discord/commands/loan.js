import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../../db/mongo.js';
import { audit } from '../../services/audit.js';

/**
 * Ciclo de vida de um empréstimo:
 *   open ──(venceu)──> overdue ──┐
 *     │                          ├──> repaid | cancelled
 *     └──────────────────────────┘
 *
 * `open` e `overdue` são ambos ATIVOS. Tratar só `open` como ativo era um bug:
 * assim que o job de lembretes marcava o vencimento, o empréstimo sumia do
 * /loan list e não podia mais ser quitado.
 * @type {readonly string[]}
 */
export const ACTIVE_STATUSES = Object.freeze(['open', 'overdue']);

const STATUS_LABEL = {
  open: 'em aberto',
  overdue: '⚠️ atrasado',
  repaid: 'pago',
  cancelled: 'cancelado',
};

/** @param {object} loan @returns {string} */
function describe(loan) {
  return loan.type === 'emeralds' ? `${loan.amount} esmeraldas` : loan.itemDesc;
}

/** @param {object} loan @returns {string} */
function fmtLoan(loan) {
  const due = `<t:${Math.floor(new Date(loan.dueAt).getTime() / 1000)}:R>`;
  return `\`${loan._id}\` — <@${loan.borrowerDiscordId}>: **${describe(loan)}** · vence ${due} · *${STATUS_LABEL[loan.status] ?? loan.status}*`;
}

/** @param {string} raw @returns {ObjectId|null} */
function toObjectId(raw) {
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
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
        .addIntegerOption((o) => o.setName('days').setDescription('Prazo em dias').setRequired(true).setMinValue(1))
        .addIntegerOption((o) => o.setName('amount').setDescription('Qtd. de esmeraldas (se emeralds)').setRequired(false).setMinValue(1))
        .addStringOption((o) => o.setName('item').setDescription('Descrição do item (se item)').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Lista empréstimos ativos (em aberto e atrasados)')
        .addUserOption((o) => o.setName('user').setDescription('Filtra por devedor').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('repay').setDescription('Marca como pago').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancela um empréstimo').addStringOption((o) => o.setName('id').setDescription('ID do empréstimo').setRequired(true)))
    .toJSON(),

  // Botão "Meus empréstimos" do painel fixo do canal.
  owns(interaction) {
    return interaction.customId === 'loan:mine';
  },

  async handleComponent(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const rows = await collections
      .loans()
      .find({ borrowerDiscordId: interaction.user.id, status: { $in: ACTIVE_STATUSES } })
      .sort({ dueAt: 1 })
      .toArray();
    if (!rows.length) return interaction.editReply('Você não tem nenhum empréstimo ativo. 👍');
    return interaction.editReply(
      `Você tem **${rows.length}** empréstimo(s) ativo(s):\n${rows.map(fmtLoan).join('\n')}`,
    );
  },

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
      const { insertedId } = await loans.insertOne({
        borrowerDiscordId: user.id,
        borrowerUuid: member?.uuid ?? null,
        type,
        amount: type === 'emeralds' ? amount : null,
        itemDesc: type === 'item' ? item : null,
        createdAt: new Date(),
        dueAt: new Date(Date.now() + days * 86_400_000),
        status: 'open',
        createdBy: interaction.user.id,
        dueSoonNotified: false,
        overdueReminders: 0,
        lastReminderAt: null,
      });
      audit(interaction.client, interaction.guildId, `💰 Empréstimo registrado para <@${user.id}> (${type}) por <@${interaction.user.id}>.`);
      return interaction.editReply(`Empréstimo registrado. ID: \`${insertedId}\`.`);
    }

    if (sub === 'list') {
      const user = interaction.options.getUser('user');
      const filter = { status: { $in: ACTIVE_STATUSES } };
      if (user) filter.borrowerDiscordId = user.id;
      const rows = await loans.find(filter).sort({ dueAt: 1 }).limit(20).toArray();
      if (!rows.length) return interaction.editReply('Nenhum empréstimo ativo.');
      return interaction.editReply(rows.map(fmtLoan).join('\n'));
    }

    // repay / cancel
    const _id = toObjectId(interaction.options.getString('id', true));
    if (!_id) return interaction.editReply('ID inválido.');

    const status = sub === 'repay' ? 'repaid' : 'cancelled';
    const res = await loans.updateOne(
      { _id, status: { $in: ACTIVE_STATUSES } }, // um atrasado também pode ser quitado
      { $set: { status, closedAt: new Date(), closedBy: interaction.user.id } },
    );
    if (!res.matchedCount) return interaction.editReply('Empréstimo não encontrado ou já fechado.');

    audit(interaction.client, interaction.guildId, `💰 Empréstimo \`${_id}\` marcado como **${STATUS_LABEL[status]}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Empréstimo marcado como **${STATUS_LABEL[status]}**.`);
  },
};
