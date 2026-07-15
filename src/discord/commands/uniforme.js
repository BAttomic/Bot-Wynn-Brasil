import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';

/**
 * Peças oficiais da Wynn Brasil disponíveis para download.
 * Os arquivos ficam em src/assets/ (entram na imagem Docker; o .dockerignore
 * só exclui *.md e node_modules).
 */
const PECAS = Object.freeze({
  uniforme: { file: 'Uniforme_Selecao.png', label: 'Uniforme da Seleção' },
  capa: { file: 'WnBR_Cape.png', label: 'Capa' },
});

/** Cria o anexo (baixável) de uma peça a partir de src/assets/. */
function anexo(peca) {
  const { file } = PECAS[peca];
  return new AttachmentBuilder(new URL(`../../assets/${file}`, import.meta.url), { name: file });
}

export default {
  data: new SlashCommandBuilder()
    .setName('uniforme')
    .setDescription('Baixe o uniforme e a capa oficiais da Wynn Brasil')
    .addStringOption((o) =>
      o
        .setName('peca')
        .setDescription('Qual peça baixar (padrão: as duas)')
        .setRequired(false)
        .addChoices(
          { name: 'Uniforme', value: 'uniforme' },
          { name: 'Capa', value: 'capa' },
          { name: 'As duas', value: 'tudo' },
        ),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const escolha = interaction.options.getString('peca') ?? 'tudo';
    const pecas = escolha === 'tudo' ? ['uniforme', 'capa'] : [escolha];
    const files = pecas.map(anexo);

    const embed = {
      title: '🇧🇷 Wynn Brasil — Skins oficiais',
      description:
        pecas.length === 1
          ? `Aqui está a **${PECAS[pecas[0]].label}**. É só clicar para baixar.`
          : 'Aqui estão o **uniforme** e a **capa** oficiais. Clique em cada imagem para baixar.',
      color: 0x2ecc71,
      // Com uma única peça dá para pré-visualizar dentro do embed.
      ...(pecas.length === 1 && { image: { url: `attachment://${PECAS[pecas[0]].file}` } }),
      footer: { text: 'Use /uniforme peca:<uniforme|capa> para baixar só uma.' },
    };

    return interaction.editReply({ embeds: [embed], files });
  },
};
