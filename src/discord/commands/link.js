import { SlashCommandBuilder } from 'discord.js';
import { linkAndClassify } from '../../services/registration.js';

// Atalho por slash para o mesmo fluxo do painel de registro. Precisa passar por
// linkAndClassify, senão um membro da guilda da black-list escaparia do cargo de
// banido simplesmente usando /link em vez do botão.
export default {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Vincula sua conta do WynnCraft ao seu Discord')
    // O /link é a porta de entrada de quem chega de fora; a descrição em inglês
    // é o que faz o comando ser encontrável para eles. A resposta em si já sai
    // no idioma de quem chamou (ver linkAndClassify).
    .setDescriptionLocalizations({
      'en-US': 'Link your WynnCraft account to your Discord',
      'en-GB': 'Link your WynnCraft account to your Discord',
    })
    .addStringOption((o) =>
      o
        .setName('nick')
        .setDescription('Seu nick no WynnCraft')
        .setDescriptionLocalizations({
          'en-US': 'Your WynnCraft username',
          'en-GB': 'Your WynnCraft username',
        })
        .setRequired(true),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const nick = interaction.options.getString('nick', true);
    return interaction.editReply(await linkAndClassify(interaction, nick));
  },
};
