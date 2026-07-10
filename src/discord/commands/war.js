import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

/** Campos do modal de aplicação para guerra. @type {readonly string[]} */
const APPLY_FIELDS = Object.freeze(['classe', 'interesse', 'funcao']);

function applyModal() {
  const field = (id, label, placeholder, required = true) =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(required)
        .setMaxLength(100),
    );

  return new ModalBuilder()
    .setCustomId('war:applyModal')
    .setTitle('Aplicação para Guerra')
    .addComponents(
      field('classe', 'Sua classe exclusiva para guerra', 'Ex.: Warrior lvl 106 (ou "não tenho")'),
      field('interesse', 'Interesse', 'WAR ou MAIN WAR'),
      field('funcao', 'Função pretendida', 'DPS, Tank ou Healer'),
    );
}

/** Publica a aplicação no canal de aplicação de guerra, para a staff avaliar. */
async function submitWarApplication(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const cfg = await getConfig(interaction.guildId);
  const channelId = cfg.channels?.warApplication ?? interaction.channelId;
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel) return interaction.editReply('Canal de aplicação de guerra inacessível.');

  const get = (id) => interaction.fields.getTextInputValue(id).trim();
  const [classe, interesse, funcao] = APPLY_FIELDS.map(get);

  await channel.send({
    embeds: [
      {
        title: '📩 Nova aplicação para guerra',
        color: 0xe74c3c,
        description: `**Jogador:** <@${interaction.user.id}>\n**Classe:** \`${classe}\`\n**Interesse:** \`${interesse}\`\n**Função:** \`${funcao}\``,
        thumbnail: { url: interaction.user.displayAvatarURL() },
        timestamp: new Date().toISOString(),
      },
    ],
    allowedMentions: { parse: [] },
  });

  audit(interaction.client, interaction.guildId, `⚔️ <@${interaction.user.id}> aplicou para guerra (${interesse}).`);
  return interaction.editReply('Aplicação enviada! A staff vai avaliar e te retornar.');
}

function hasWarRole(member, cfg) {
  const ids = [cfg.roles?.war, cfg.roles?.mainWar].filter(Boolean);
  return ids.some((id) => member.roles.cache.has(id));
}

function warButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('war:att:yes').setLabel('Vou').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('war:att:no').setLabel('Não vou').setStyle(ButtonStyle.Danger),
  );
}

function callEmbed(call) {
  const going = call.going.map((id) => `<@${id}>`).join(', ') || '—';
  const not = call.notGoing.map((id) => `<@${id}>`).join(', ') || '—';
  return {
    title: '⚔️ Convocação de Guerra!',
    description: call.note || 'Reúnam-se para a guerra!',
    color: 0xe67e22,
    fields: [
      { name: `Vou (${call.going.length})`, value: going },
      { name: `Não vou (${call.notGoing.length})`, value: not },
    ],
    footer: { text: `Chamado por ${call.createdByName}` },
  };
}

async function handleAttend(interaction, answer) {
  const warCalls = collections.warCalls();
  const call = await warCalls.findOne({ messageId: interaction.message.id });
  if (!call) return interaction.reply({ content: 'Convocação não encontrada.', ephemeral: true });

  const uid = interaction.user.id;
  const going = new Set(call.going);
  const notGoing = new Set(call.notGoing);
  going.delete(uid);
  notGoing.delete(uid);
  if (answer === 'yes') going.add(uid);
  else notGoing.add(uid);

  call.going = [...going];
  call.notGoing = [...notGoing];
  await warCalls.updateOne(
    { messageId: interaction.message.id },
    { $set: { going: call.going, notGoing: call.notGoing } },
  );
  await interaction.update({ embeds: [callEmbed(call)], components: [warButtons()] });
}

export default {
  data: new SlashCommandBuilder()
    .setName('war')
    .setDescription('(WAR/MAIN WAR) Dispara uma convocação de guerra')
    .addStringOption((o) => o.setName('nota').setDescription('Mensagem opcional').setRequired(false))
    .toJSON(),

  // Botões da convocação (war:att:*), botão do painel (war:apply) e o modal.
  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('war:');
  },

  async handleComponent(interaction) {
    if (interaction.isModalSubmit?.() && interaction.customId === 'war:applyModal') {
      return submitWarApplication(interaction);
    }
    const [, action, answer] = interaction.customId.split(':');
    if (action === 'att') return handleAttend(interaction, answer);
    if (action === 'apply') return interaction.showModal(applyModal());
  },

  async execute(interaction) {
    const cfg = await getConfig(interaction.guildId);
    if (!hasWarRole(interaction.member, cfg)) {
      return interaction.reply({ content: 'Apenas cargos WAR / MAIN WAR podem convocar guerra.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const note = interaction.options.getString('nota');
    const channelId = cfg.channels?.war;
    const channel = channelId
      ? await interaction.client.channels.fetch(channelId).catch(() => null)
      : interaction.channel;
    if (!channel) return interaction.editReply('Canal de guerra não configurado/acessível.');

    const roleId = cfg.roles?.war;
    const call = {
      going: [],
      notGoing: [],
      note,
      createdBy: interaction.user.id,
      createdByName: interaction.user.username,
    };
    const msg = await channel.send({
      content: roleId ? `<@&${roleId}>` : '',
      embeds: [callEmbed(call)],
      components: [warButtons()],
      allowedMentions: { roles: roleId ? [roleId] : [] },
    });
    await collections.warCalls().insertOne({
      messageId: msg.id,
      channelId: channel.id,
      guildDiscordId: interaction.guildId,
      createdAt: new Date(),
      ...call,
    });
    audit(interaction.client, interaction.guildId, `⚔️ <@${interaction.user.id}> convocou guerra.`);
    return interaction.editReply('Convocação enviada!');
  },
};
