import { SlashCommandBuilder } from 'discord.js';
import { RECRUTADOR, openDemoteVote } from '../../services/promotions.js';

export default {
  // Visível para todos, como o /promover: quem barra é o roteador, pelo cargo.
  // Os botões da votação são do /promover (prefixo `promo:`).
  data: new SlashCommandBuilder()
    .setName('rebaixar')
    .setDescription('(Chefes) Abre a votação dos Chefes (Staff) para descer alguém a qualquer cargo abaixo')
    .addUserOption((o) => o.setName('membro').setDescription('Quem desce').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('cargo')
        .setDescription('Para qual cargo')
        .setRequired(true)
        .addChoices(
          { name: 'Estrategista (Staff)', value: 'estrategistaStaff' },
          { name: 'Capitão (Staff)', value: 'capitaoStaff' },
          { name: 'Recrutador — sai da Staff', value: RECRUTADOR },
        ),
    )
    .addStringOption((o) => o.setName('motivo').setDescription('Aparece na votação para os Chefes').setMaxLength(500))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const resposta = await openDemoteVote(interaction.client, interaction.guild, {
      alvoId: interaction.options.getUser('membro', true).id,
      cargo: interaction.options.getString('cargo', true),
      motivo: interaction.options.getString('motivo')?.trim() || null,
      por: interaction.member,
    });
    return interaction.editReply({ content: resposta, allowedMentions: { parse: [] } });
  },
};
