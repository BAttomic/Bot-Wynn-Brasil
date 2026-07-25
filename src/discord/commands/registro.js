import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import {
  BUTTON_ID,
  MODAL_ID,
  NICK_FIELD,
  ensureRegistrationPanel,
  linkAndClassify,
  nickModal,
} from '../../services/registration.js';

export default {
  data: new SlashCommandBuilder()
    .setName('registro')
    .setDescription('Gestão do canal de registro')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s.setName('publicar').setDescription('Publica ou atualiza a mensagem do painel de registro'),
    )
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('registro:');
  },

  async handleComponent(interaction) {
    if (interaction.isButton() && interaction.customId === BUTTON_ID) {
      return interaction.showModal(nickModal());
    }
    if (interaction.isModalSubmit() && interaction.customId === MODAL_ID) {
      await interaction.deferReply({ ephemeral: true });
      const nick = interaction.fields.getTextInputValue(NICK_FIELD);
      const result = await linkAndClassify(interaction, nick);
      return interaction.editReply(result);
    }
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const id = await ensureRegistrationPanel(interaction.client, interaction.guildId);
    if (!id) {
      return interaction.editReply(
        'Canal de registro não configurado ou inacessível. Use `/config channel key:registration`.',
      );
    }
    return interaction.editReply('Painel de registro publicado/atualizado.');
  },
};
