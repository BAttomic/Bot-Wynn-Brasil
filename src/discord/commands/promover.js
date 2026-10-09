import { SlashCommandBuilder } from 'discord.js';
import { PROMO_PREFIX, handlePromotionButton, openManualVote } from '../../services/promotions.js';

export default {
  // Visível para todos: quem barra é o roteador, pelo cargo (ver commandLoader).
  data: new SlashCommandBuilder()
    .setName('promover')
    .setDescription('(Chefes) Abre a votação dos Chefes (Staff) para pôr alguém em qualquer cargo acima do atual')
    .addUserOption((o) => o.setName('membro').setDescription('Quem sobe').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('cargo')
        .setDescription('Para qual cargo')
        .setRequired(true)
        .addChoices(
          { name: 'Chefe (Staff) — o Fundador confirma', value: 'chefeStaff' },
          { name: 'Estrategista (Staff)', value: 'estrategistaStaff' },
          { name: 'Capitão (Staff)', value: 'capitaoStaff' },
        ),
    )
    .addStringOption((o) => o.setName('motivo').setDescription('Aparece na votação para os Chefes').setMaxLength(500))
    .toJSON(),

  // Os botões da votação no canal dos Chefes e os de confirmação na DM do
  // Fundador — de promoção e também de rebaixamento (/rebaixar), que usa a
  // mesma votação. A DM não tem comando por trás, então quem os adota é este
  // comando.
  owns(interaction) {
    return interaction.isButton?.() && interaction.customId.startsWith(PROMO_PREFIX);
  },

  handleComponent(interaction) {
    return handlePromotionButton(interaction);
  },

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const resposta = await openManualVote(interaction.client, interaction.guild, {
      alvoId: interaction.options.getUser('membro', true).id,
      cargo: interaction.options.getString('cargo', true),
      motivo: interaction.options.getString('motivo')?.trim() || null,
      por: interaction.member,
    });
    return interaction.editReply({ content: resposta, allowedMentions: { parse: [] } });
  },
};
