import { SlashCommandBuilder } from 'discord.js';
import { computeVerification, verificationEmbed } from '../../services/verification.js';
import { BUTTON_PREFIX, handleInactivityButton } from '../../services/inactivityCheck.js';

export default {
  data: new SlashCommandBuilder()
    .setName('verificar')
    .setDescription('Relatório de verificação: quem está na guilda vs. vínculo no Discord')
    .toJSON(),

  // Os botões do check-in de inatividade chegam pela DM, sem comando por trás. O
  // roteador de componentes só conhece comandos (ver commandLoader.js), então
  // quem adota os botões é o comando que mostra o resultado deles.
  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith(BUTTON_PREFIX);
  },

  handleComponent(interaction) {
    return handleInactivityButton(interaction);
  },

  async execute(interaction) {
    await interaction.deferReply();
    const data = await computeVerification();
    if (!data) return interaction.editReply('Não consegui obter os dados da guilda.');
    return interaction.editReply({ embeds: [verificationEmbed(data)] });
  },
};
