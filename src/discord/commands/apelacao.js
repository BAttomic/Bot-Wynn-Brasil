import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

const BUTTON_NEW = 'appeal:new';
const MODAL_ID = 'appeal:modal';
const REASON_FIELD = 'motivo';

const SILENT = { allowedMentions: { parse: [] } };

/** Mesmos cargos de liderança do /forcelink, ou Gerenciar Servidor. */
async function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const { params } = await getConfig(interaction.guildId);
  const roles = Array.isArray(params?.voterRoles) ? params.voterRoles : [];
  return roles.some((id) => interaction.member?.roles?.cache?.has(id));
}

/** Nome de tópico do Discord: teto de 100 caracteres. */
function threadName(nick) {
  return `Apelação — ${nick}`.slice(0, 100);
}

/** Resolve o canal de apelações configurado; null se ausente/inacessível. */
async function appealsChannel(interaction) {
  const cfg = await getConfig(interaction.guildId);
  const id = cfg.channels?.appeals;
  if (!id) return null;
  const channel = await interaction.client.channels.fetch(id).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  return channel;
}

/**
 * Cria o tópico público e posta a primeira mensagem.
 * @returns {Promise<import('discord.js').ThreadChannel|null>}
 */
async function createThread(channel, { nick, body }) {
  const thread = await channel.threads
    .create({
      name: threadName(nick),
      type: ChannelType.PublicThread,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
      reason: 'Apelação aberta',
    })
    .catch(() => null);
  if (!thread) return null;
  await thread.send({ ...SILENT, content: body }).catch(() => {});
  return thread;
}

export default {
  data: new SlashCommandBuilder()
    .setName('apelacao')
    .setDescription('Central de apelações da comunidade')
    .addSubcommand((s) =>
      s
        .setName('abrir')
        .setDescription('(Staff) Abre um tópico de apelação em nome de alguém')
        .addUserOption((o) => o.setName('user').setDescription('Quem está apelando').setRequired(true))
        .addStringOption((o) => o.setName('motivo').setDescription('Contexto da punição / do caso').setRequired(false)),
    )
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('appeal:');
  },

  async handleComponent(interaction) {
    // Botão do painel → abre o formulário.
    if (interaction.customId === BUTTON_NEW) {
      const modal = new ModalBuilder()
        .setCustomId(MODAL_ID)
        .setTitle('Fazer apelação')
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(REASON_FIELD)
              .setLabel('Explique o seu caso')
              .setPlaceholder('O que aconteceu, por que acha que foi engano, qualquer prova…')
              .setStyle(TextInputStyle.Paragraph)
              .setMinLength(10)
              .setMaxLength(1500)
              .setRequired(true),
          ),
        );
      return interaction.showModal(modal);
    }

    // Envio do formulário → cria o tópico do próprio usuário.
    if (interaction.customId === MODAL_ID) {
      await interaction.deferReply({ ephemeral: true });
      const channel = await appealsChannel(interaction);
      if (!channel) return interaction.editReply('O canal de apelações não está configurado. Avise a staff.');

      const nick = interaction.member?.nickname || interaction.user.username;
      const reason = interaction.fields.getTextInputValue(REASON_FIELD).trim();
      const thread = await createThread(channel, {
        nick,
        body: `🕊️ **Apelação de <@${interaction.user.id}>**\n\n${reason}`,
      });
      if (!thread) return interaction.editReply('Não consegui abrir o tópico. Confira as permissões do bot no canal de apelações.');

      audit(interaction.client, interaction.guildId, `🕊️ <@${interaction.user.id}> abriu uma apelação.`);
      return interaction.editReply(`Apelação aberta em <#${thread.id}>. A staff responde por lá.`);
    }
  },

  async execute(interaction) {
    // Só existe o subcomando `abrir`, restrito à staff.
    if (!(await isStaff(interaction))) {
      return interaction.reply({ content: 'Apenas a staff pode abrir apelação por outra pessoa.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const channel = await appealsChannel(interaction);
    if (!channel) return interaction.editReply('Configure o canal com `/config channel key:appeals` primeiro.');

    const user = interaction.options.getUser('user', true);
    const motivo = interaction.options.getString('motivo');
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    const nick = member?.nickname || user.username;

    const body =
      `🕊️ **Apelação de <@${user.id}>** — aberta pela staff (<@${interaction.user.id}>)` +
      (motivo ? `\n\n${motivo}` : '');
    const thread = await createThread(channel, { nick, body });
    if (!thread) return interaction.editReply('Não consegui abrir o tópico. Confira as permissões do bot no canal.');

    audit(interaction.client, interaction.guildId, `🕊️ <@${interaction.user.id}> abriu uma apelação para <@${user.id}>.`);
    return interaction.editReply(`Tópico de apelação aberto em <#${thread.id}> para <@${user.id}>.`);
  },
};
