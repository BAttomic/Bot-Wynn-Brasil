import { SlashCommandBuilder } from 'discord.js';
import { computeVerification, verificationEmbed } from '../../services/verification.js';

export default {
  data: new SlashCommandBuilder()
    .setName('verificar')
    .setDescription('Relatório de verificação: quem está na guilda vs. vínculo no Discord')
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const data = await computeVerification();
    if (!data) return interaction.editReply('Não consegui obter os dados da guilda.');
    return interaction.editReply({ embeds: [verificationEmbed(data)] });
  },
};
