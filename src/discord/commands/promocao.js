import { SlashCommandBuilder } from 'discord.js';
import { PROMO_PREFIX, handlePromotionButton, openManualVote } from '../../services/promotions.js';

export default {
  data: new SlashCommandBuilder()
    .setName('promocao')
    .setDescription('(Chefes) Votação de promoção da Staff')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) =>
      s
        .setName('abrir')
        .setDescription('Abre a votação dos Chefes (Staff) para promover alguém')
        .addUserOption((o) => o.setName('membro').setDescription('Quem sobe').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('cargo')
            .setDescription('Para qual cargo')
            .setRequired(true)
            .addChoices(
              { name: 'Chefe (Staff) — para quem é Estrategista (Staff); o Fundador confirma', value: 'chefeStaff' },
              { name: 'Estrategista (Staff) — reabrir para quem é Capitão (Staff) e tem 5.000 pontos', value: 'estrategistaStaff' },
            ),
        ),
    )
    .toJSON(),

  // Os botões da votação no canal dos Chefes e os de confirmação na DM do
  // Fundador. A DM não tem comando por trás, então quem os adota é o comando
  // que abre a votação.
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
      por: interaction.member,
    });
    return interaction.editReply({ content: resposta, allowedMentions: { parse: [] } });
  },
};
