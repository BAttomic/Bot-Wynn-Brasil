import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

/**
 * Convocação de guerra. Pinga a WnBR War Team; convoca quem é da War Team ou
 * tem algum MAIN WAR.
 *
 * O cargo WAR e a aplicação para ele saíram do servidor: a War Team passou a
 * ser por contagem de guerras. Os botões da aplicação antiga (`war:apply`,
 * `war:set:*`, `war:send`) ainda podem estar numa mensagem velha, e respondem
 * que o fluxo foi encerrado em vez de cair em "este botão não responde mais".
 */
const WAR_TEAM_ROLE = '1554163813387993208';
const MAIN_WAR_ROLES = Object.freeze([
  '1333249418945892422', // MAIN WAR - DPS
  '1333249422137495664', // MAIN WAR - HEALER
  '1333249407193448548', // MAIN WAR - TANK
  '1332557073656975370', // MAIN WAR - SOLO
]);

function canCallWar(member) {
  return [WAR_TEAM_ROLE, ...MAIN_WAR_ROLES].some((id) => member.roles.cache.has(id));
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
    title: ':crossed_swords: Convocação de Guerra!',
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
    .setDescription('(War Team/MAIN WAR) Dispara uma convocação de guerra')
    .addStringOption((o) => o.setName('nota').setDescription('Mensagem opcional').setRequired(false))
    .toJSON(),

  // war:att:* (convocação). war:apply, war:set:* e war:send são da aplicação
  // encerrada.
  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('war:');
  },

  async handleComponent(interaction) {
    const [, action, field] = interaction.customId.split(':');
    if (action === 'att') return handleAttend(interaction, field);
    return interaction.reply({
      content: 'A aplicação para o cargo de guerra foi encerrada. A WnBR War Team agora é por contagem de guerras.',
      ephemeral: true,
    });
  },

  async execute(interaction) {
    if (!canCallWar(interaction.member)) {
      return interaction.reply({ content: 'Apenas a War Team e os MAIN WAR podem convocar guerra.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const cfg = await getConfig(interaction.guildId);
    const note = interaction.options.getString('nota');
    const channelId = cfg.channels?.war;
    const channel = channelId
      ? await interaction.client.channels.fetch(channelId).catch(() => null)
      : interaction.channel;
    if (!channel) return interaction.editReply('Canal de guerra não configurado/acessível.');

    const call = {
      going: [],
      notGoing: [],
      note,
      createdBy: interaction.user.id,
      createdByName: interaction.user.username,
    };
    const msg = await channel.send({
      content: `<@&${WAR_TEAM_ROLE}>`,
      embeds: [callEmbed(call)],
      components: [warButtons()],
      allowedMentions: { roles: [WAR_TEAM_ROLE] },
    });
    await collections.warCalls().insertOne({
      messageId: msg.id,
      channelId: channel.id,
      guildDiscordId: interaction.guildId,
      createdAt: new Date(),
      ...call,
    });
    audit(interaction.client, interaction.guildId, `:crossed_swords: <@${interaction.user.id}> convocou guerra.`);
    return interaction.editReply('Convocação enviada!');
  },
};
