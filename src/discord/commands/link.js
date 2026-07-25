import { SlashCommandBuilder } from 'discord.js';
import { linkAndClassify } from '../../services/registration.js';

// Atalho por slash para o mesmo fluxo do painel de registro. Precisa passar por
// linkAndClassify, senão um membro da guilda da black-list escaparia do cargo de
// banido simplesmente usando /link em vez do botão.
export default {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Vincula sua conta do WynnCraft ao seu Discord')
    .addStringOption((o) =>
      o.setName('nick').setDescription('Seu nick no WynnCraft').setRequired(true),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const nick = interaction.options.getString('nick', true);
    return interaction.editReply(await linkAndClassify(interaction, nick));
  },
};
