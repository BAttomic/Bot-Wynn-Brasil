import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
} from 'discord.js';
import { ObjectId } from 'mongodb';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
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

/** Prazo padrão de todo empréstimo. Devolver antes é sempre permitido. */
export const DEFAULT_LOAN_DAYS = 7;

/**
 * Ranks DA GUILDA que podem abrir um empréstimo. "Chief ou superior" = chief e
 * owner, já que `guildRank` guarda o rank real do jogo.
 * @type {readonly string[]}
 */
const MANAGER_GUILD_RANKS = Object.freeze(['chief', 'owner']);

const STATUS_LABEL = {
  open: 'em aberto',
  overdue: '⚠️ atrasado',
  repaid: 'pago',
  cancelled: 'cancelado',
};

const DAY_MS = 86_400_000;

/** @param {object} loan @returns {string} */
function describe(loan) {
  return loan.type === 'emeralds' ? `${loan.amount} esmeraldas` : loan.itemDesc;
}

/** @param {object} loan @returns {string} */
function fmtLoan(loan) {
  const due = `<t:${Math.floor(new Date(loan.dueAt).getTime() / 1000)}:R>`;
  const thread = loan.threadId ? ` · <#${loan.threadId}>` : '';
  return `\`${loan._id}\` — <@${loan.borrowerDiscordId}>: **${describe(loan)}** · vence ${due} · *${STATUS_LABEL[loan.status] ?? loan.status}*${thread}`;
}

/** @param {string} raw @returns {ObjectId|null} */
function toObjectId(raw) {
  try {
    return new ObjectId(raw);
  } catch {
    return null;
  }
}

/**
 * Staff do Discord, ou Chief/Owner da guilda no jogo.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
async function isLoanManager(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const linked = await collections.members().findOne({ discordId: interaction.user.id });
  return MANAGER_GUILD_RANKS.includes(linked?.guildRank);
}

const PLACEHOLDER_ITEMS = 'A definir';
const ITEMS_FIELD_LIMIT = 1024; // limite de um campo de embed

const STATUS_COLOR = {
  open: 0xf1c40f,
  overdue: 0xe74c3c,
  repaid: 0x2ecc71,
  cancelled: 0x95a5a6,
};

/**
 * A mensagem viva do acordo, dentro do tópico. É reeditada a cada mudança, em
 * vez de virar uma pilha de mensagens de "atualizei o prazo".
 * @param {object} loan
 * @returns {import('discord.js').APIEmbed}
 */
function agreementEmbed(loan) {
  const due = Math.floor(new Date(loan.dueAt).getTime() / 1000);
  const confirmado = loan.confirmedAt
    ? `✅ Confirmado por <@${loan.borrowerDiscordId}> <t:${Math.floor(new Date(loan.confirmedAt).getTime() / 1000)}:R>`
    : '⏳ Aguardando o devedor clicar em **Confirmar recebimento**';

  return {
    title: '📄 Acordo de Empréstimo',
    color: STATUS_COLOR[loan.status] ?? 0xf1c40f,
    fields: [
      { name: 'Devedor', value: `<@${loan.borrowerDiscordId}>`, inline: true },
      { name: 'Situação', value: STATUS_LABEL[loan.status] ?? loan.status, inline: true },
      { name: 'Devolução', value: `<t:${due}:D> · <t:${due}:R>`, inline: true },
      {
        name: '📦 Itens emprestados',
        value: (loan.itemDesc || PLACEHOLDER_ITEMS).slice(0, ITEMS_FIELD_LIMIT),
      },
      { name: 'Confirmação', value: confirmado },
    ],
    footer: { text: `ID ${loan._id} · devolução antecipada é sempre livre` },
  };
}

/** @param {object} loan @returns {ActionRowBuilder[]} */
function agreementRows(loan) {
  if (!ACTIVE_STATUSES.includes(loan.status)) return []; // fechado: sem botões
  const id = loan._id.toString();

  const btn = (action, label, emoji, style, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`loan:${action}:${id}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(style)
      .setDisabled(disabled);

  return [
    new ActionRowBuilder().addComponents(
      btn('confirm', 'Confirmar recebimento', '✅', ButtonStyle.Success, !!loan.confirmedAt),
      btn('items', 'Editar itens', '📦', ButtonStyle.Secondary),
      btn('due', 'Alterar prazo', '📅', ButtonStyle.Secondary),
      btn('close', 'Devolvido', '🔒', ButtonStyle.Danger),
    ),
  ];
}

/**
 * Reescreve a mensagem do acordo com o estado atual do empréstimo.
 * Modais não trazem `interaction.message`, por isso guardamos o messageId.
 */
async function refreshAgreement(client, loan) {
  if (!loan.threadId || !loan.messageId) return;
  const thread = await client.channels.fetch(loan.threadId).catch(() => null);
  const msg = await thread?.messages.fetch(loan.messageId).catch(() => null);
  await msg?.edit({ embeds: [agreementEmbed(loan)], components: agreementRows(loan) }).catch(() => {});
}

/** @param {string} id @returns {Promise<object|null>} */
function findLoan(id) {
  const _id = toObjectId(id);
  return _id ? collections.loans().findOne({ _id }) : null;
}

/** Passo 1 do botão: escolher o devedor. */
async function promptBorrower(interaction) {
  if (!(await isLoanManager(interaction))) {
    return interaction.reply({
      content: 'Apenas **Chief ou superior** pode abrir um empréstimo.',
      ephemeral: true,
    });
  }
  const menu = new UserSelectMenuBuilder()
    .setCustomId('loan:borrower')
    .setPlaceholder('Quem vai receber o empréstimo?')
    .setMaxValues(1);

  return interaction.reply({
    content: `Escolha o devedor. O prazo padrão é de **${DEFAULT_LOAN_DAYS} dias**.`,
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/** Passo 2: cria o tópico, adiciona o membro e registra o empréstimo. */
async function openLoanThread(interaction) {
  if (!(await isLoanManager(interaction))) {
    return interaction.update({ content: 'Sem permissão.', components: [] });
  }
  await interaction.deferUpdate();

  const borrowerId = interaction.values[0];
  const cfg = await getConfig(interaction.guildId);
  const channel = await interaction.client.channels
    .fetch(cfg.channels?.loans ?? interaction.channelId)
    .catch(() => null);
  if (!channel) {
    return interaction.editReply({ content: 'Canal de empréstimos inacessível.', components: [] });
  }

  const borrower = await interaction.guild.members.fetch(borrowerId).catch(() => null);
  const name = borrower?.displayName ?? borrowerId;
  const dueAt = new Date(Date.now() + DEFAULT_LOAN_DAYS * DAY_MS);

  const thread = await channel.threads.create({
    name: `Empréstimo — ${name}`.slice(0, 100),
    autoArchiveDuration: 10080, // 7 dias, igual ao prazo
    type: ChannelType.PublicThread,
    reason: `Empréstimo aberto por ${interaction.user.tag}`,
  });
  await thread.members.add(borrowerId).catch(() => {});

  const linked = await collections.members().findOne({ discordId: borrowerId });
  const loan = {
    borrowerDiscordId: borrowerId,
    borrowerUuid: linked?.uuid ?? null,
    type: 'item',
    amount: null,
    itemDesc: PLACEHOLDER_ITEMS,
    createdAt: new Date(),
    dueAt,
    status: 'open',
    createdBy: interaction.user.id,
    threadId: thread.id,
    messageId: null,
    confirmedAt: null,
    dueSoonNotified: false,
    overdueReminders: 0,
    lastReminderAt: null,
  };
  const { insertedId } = await collections.loans().insertOne(loan);
  loan._id = insertedId;

  // A mensagem do acordo é o painel de controle do empréstimo; guardamos o id
  // dela porque um modal não devolve `interaction.message`.
  const msg = await thread.send({
    content: `<@${borrowerId}>`,
    embeds: [agreementEmbed(loan)],
    components: agreementRows(loan),
    allowedMentions: { users: [borrowerId] },
  });
  await collections.loans().updateOne({ _id: insertedId }, { $set: { messageId: msg.id } });

  audit(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> abriu empréstimo para <@${borrowerId}> em <#${thread.id}>.`);
  return interaction.editReply({
    content: `Tópico criado: <#${thread.id}> · ID \`${insertedId}\`. Use os botões de lá para listar os itens.`,
    components: [],
  });
}

/** Só a staff mexe no acordo; o devedor só confirma. */
async function requireManager(interaction) {
  if (await isLoanManager(interaction)) return true;
  await interaction.reply({ content: 'Apenas **Chief ou superior** pode fazer isso.', ephemeral: true });
  return false;
}

/** Modal com os itens atuais já preenchidos, para editar em vez de redigitar. */
async function promptItems(interaction, id) {
  if (!(await requireManager(interaction))) return;
  const loan = await findLoan(id);
  if (!loan) return interaction.reply({ content: 'Empréstimo não encontrado.', ephemeral: true });

  const atual = loan.itemDesc === PLACEHOLDER_ITEMS ? '' : loan.itemDesc ?? '';
  const input = new TextInputBuilder()
    .setCustomId('itens')
    .setLabel('Itens emprestados (um por linha)')
    .setPlaceholder('Bloodmoon (itemlock)\nBreezehands\nCódigo do trade: ABC123')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(ITEMS_FIELD_LIMIT)
    .setRequired(true)
    .setValue(atual.slice(0, ITEMS_FIELD_LIMIT));

  return interaction.showModal(
    new ModalBuilder()
      .setCustomId(`loan:itemsModal:${id}`)
      .setTitle('Itens do empréstimo')
      .addComponents(new ActionRowBuilder().addComponents(input)),
  );
}

async function saveItems(interaction, id) {
  await interaction.deferReply({ ephemeral: true });
  const itens = interaction.fields.getTextInputValue('itens').trim();

  const loan = await collections.loans().findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set: { itemDesc: itens } },
    { returnDocument: 'after' },
  );
  if (!loan) return interaction.editReply('Empréstimo não encontrado.');

  await refreshAgreement(interaction.client, loan);
  return interaction.editReply('Itens atualizados no acordo.');
}

/** Modal de prazo: dias a partir de hoje. */
async function promptDue(interaction, id) {
  if (!(await requireManager(interaction))) return;

  const input = new TextInputBuilder()
    .setCustomId('dias')
    .setLabel('Novo prazo, em dias a partir de hoje')
    .setPlaceholder(String(DEFAULT_LOAN_DAYS))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(3)
    .setRequired(true);

  return interaction.showModal(
    new ModalBuilder()
      .setCustomId(`loan:dueModal:${id}`)
      .setTitle('Alterar prazo')
      .addComponents(new ActionRowBuilder().addComponents(input)),
  );
}

async function saveDue(interaction, id) {
  await interaction.deferReply({ ephemeral: true });
  const dias = Number.parseInt(interaction.fields.getTextInputValue('dias'), 10);
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) {
    return interaction.editReply('Informe um número inteiro de dias, entre 1 e 365.');
  }

  const dueAt = new Date(Date.now() + dias * DAY_MS);
  const loan = await collections.loans().findOneAndUpdate(
    { _id: toObjectId(id), status: { $in: ACTIVE_STATUSES } },
    {
      // Prazo novo zera o ciclo de cobrança: um atrasado volta a ficar em dia,
      // e os lembretes recomeçam do zero.
      $set: { dueAt, status: 'open', dueSoonNotified: false, overdueReminders: 0, lastReminderAt: null },
    },
    { returnDocument: 'after' },
  );
  if (!loan) return interaction.editReply('Empréstimo não encontrado ou já fechado.');

  await refreshAgreement(interaction.client, loan);
  audit(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> alterou o prazo do empréstimo \`${id}\` para ${dias}d.`);
  return interaction.editReply(`Prazo atualizado para **${dias} dias**. Os lembretes recomeçam.`);
}

/** Só o devedor confirma que recebeu. */
async function confirmReceipt(interaction, id) {
  const loan = await findLoan(id);
  if (!loan) return interaction.reply({ content: 'Empréstimo não encontrado.', ephemeral: true });
  if (loan.borrowerDiscordId !== interaction.user.id) {
    return interaction.reply({ content: 'Só o devedor pode confirmar o recebimento.', ephemeral: true });
  }
  if (loan.confirmedAt) {
    return interaction.reply({ content: 'Você já confirmou.', ephemeral: true });
  }

  await interaction.deferUpdate();
  const atualizado = await collections.loans().findOneAndUpdate(
    { _id: loan._id },
    { $set: { confirmedAt: new Date() } },
    { returnDocument: 'after' },
  );
  await refreshAgreement(interaction.client, atualizado);
  audit(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> confirmou o recebimento do empréstimo \`${id}\`.`);
}

/** Fecha o empréstimo e arquiva o tópico. */
async function closeLoan(interaction, id) {
  if (!(await requireManager(interaction))) return;
  await interaction.deferUpdate();

  const loan = await collections.loans().findOneAndUpdate(
    { _id: toObjectId(id), status: { $in: ACTIVE_STATUSES } },
    { $set: { status: 'repaid', closedAt: new Date(), closedBy: interaction.user.id } },
    { returnDocument: 'after' },
  );
  if (!loan) return;

  await refreshAgreement(interaction.client, loan);
  audit(interaction.client, interaction.guildId, `💰 <@${interaction.user.id}> encerrou o empréstimo \`${id}\` (devolvido).`);

  const thread = await interaction.client.channels.fetch(loan.threadId).catch(() => null);
  await thread?.send('🔒 Empréstimo devolvido. Tópico arquivado.').catch(() => {});
  await thread?.setArchived(true).catch(() => {});
}

/** Botão "Meus empréstimos". */
async function myLoans(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const rows = await collections
    .loans()
    .find({ borrowerDiscordId: interaction.user.id, status: { $in: ACTIVE_STATUSES } })
    .sort({ dueAt: 1 })
    .toArray();
  if (!rows.length) return interaction.editReply('Você não tem nenhum empréstimo ativo. 👍');
  return interaction.editReply(`Você tem **${rows.length}** empréstimo(s) ativo(s):\n${rows.map(fmtLoan).join('\n')}`);
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
        .addIntegerOption((o) => o.setName('days').setDescription(`Prazo em dias (padrão: ${DEFAULT_LOAN_DAYS})`).setRequired(false).setMinValue(1))
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

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('loan:');
  },

  async handleComponent(interaction) {
    const [, action, id] = interaction.customId.split(':');

    if (action === 'mine') return myLoans(interaction);
    if (action === 'new') return promptBorrower(interaction);
    if (action === 'borrower') return openLoanThread(interaction);

    // Ações dentro do tópico, todas carregando o id do empréstimo.
    if (action === 'items') return promptItems(interaction, id);
    if (action === 'itemsModal') return saveItems(interaction, id);
    if (action === 'due') return promptDue(interaction, id);
    if (action === 'dueModal') return saveDue(interaction, id);
    if (action === 'confirm') return confirmReceipt(interaction, id);
    if (action === 'close') return closeLoan(interaction, id);
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const loans = collections.loans();

    if (sub === 'new') {
      const user = interaction.options.getUser('user', true);
      const type = interaction.options.getString('type', true);
      const days = interaction.options.getInteger('days') ?? DEFAULT_LOAN_DAYS;
      const amount = interaction.options.getInteger('amount');
      const item = interaction.options.getString('item');
      if (type === 'emeralds' && !amount) return interaction.editReply('Informe `amount` para empréstimo de esmeraldas.');
      if (type === 'item' && !item) return interaction.editReply('Informe `item` para empréstimo de item.');

      const linked = await collections.members().findOne({ discordId: user.id });
      const { insertedId } = await loans.insertOne({
        borrowerDiscordId: user.id,
        borrowerUuid: linked?.uuid ?? null,
        type,
        amount: type === 'emeralds' ? amount : null,
        itemDesc: type === 'item' ? item : null,
        createdAt: new Date(),
        dueAt: new Date(Date.now() + days * DAY_MS),
        status: 'open',
        createdBy: interaction.user.id,
        threadId: null,
        dueSoonNotified: false,
        overdueReminders: 0,
        lastReminderAt: null,
      });
      audit(interaction.client, interaction.guildId, `💰 Empréstimo registrado para <@${user.id}> (${type}, ${days}d) por <@${interaction.user.id}>.`);
      return interaction.editReply(`Empréstimo registrado por **${days} dias**. ID: \`${insertedId}\`.`);
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
    const res = await loans.findOneAndUpdate(
      { _id, status: { $in: ACTIVE_STATUSES } }, // um atrasado também pode ser quitado
      { $set: { status, closedAt: new Date(), closedBy: interaction.user.id } },
      { returnDocument: 'after' },
    );
    if (!res) return interaction.editReply('Empréstimo não encontrado ou já fechado.');

    // Mantém o acordo no tópico coerente com o estado final, e arquiva.
    await refreshAgreement(interaction.client, res);
    if (res.threadId) {
      const thread = await interaction.client.channels.fetch(res.threadId).catch(() => null);
      await thread?.setArchived(true).catch(() => {});
    }

    audit(interaction.client, interaction.guildId, `💰 Empréstimo \`${_id}\` marcado como **${STATUS_LABEL[status]}** por <@${interaction.user.id}>.`);
    return interaction.editReply(`Empréstimo marcado como **${STATUS_LABEL[status]}**.`);
  },
};
