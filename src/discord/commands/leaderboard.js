import { SlashCommandBuilder } from 'discord.js';
import { getActiveSeason } from '../../services/seasons.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from '../../services/points.js';
import {
  SELECT_ID,
  ME_ID,
  handleLeaderboardSelect,
  handleMyPoints,
  renderPoints,
  renderCategory,
} from '../../services/leaderboardPanel.js';

// Resolve a season pedida. "atual" usa a ativa; vazio significa acumulado.
async function resolveSeason(raw) {
  if (!raw) return null;
  if (raw.toLowerCase() === 'atual') return (await getActiveSeason())?.seasonId ?? null;
  return raw;
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Placar da guilda (apurado 1x por dia, top 15)')
    .addSubcommand((s) =>
      s
        .setName('pontos')
        .setDescription('Ranking de pontos de contribuição')
        .addStringOption((o) =>
          o.setName('season').setDescription('ID da season, ou "atual" (padrão: acumulado)').setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('categoria')
        .setDescription('Ranking de uma fonte específica, em números crus')
        .addStringOption((o) =>
          o
            .setName('tipo')
            .setDescription('Qual fonte')
            .setRequired(true)
            .addChoices(...Object.entries(CATEGORIES).map(([value, c]) => ({ name: c.label, value }))),
        )
        .addStringOption((o) =>
          o.setName('season').setDescription('ID da season, ou "atual" (padrão: acumulado)').setRequired(false),
        ),
    )
    .toJSON(),

  // Componentes do painel fixo no canal de status.
  owns(interaction) {
    return interaction.customId === SELECT_ID || interaction.customId === ME_ID;
  },

  handleComponent(interaction) {
    if (interaction.customId === ME_ID) return handleMyPoints(interaction);
    return handleLeaderboardSelect(interaction);
  },

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const seasonId = await resolveSeason(interaction.options.getString('season'));

    if (sub === 'pontos') {
      const doc = await pointsLeaderboard(seasonId ? 'season' : 'alltime', seasonId);
      return interaction.editReply({ embeds: [renderPoints(doc, seasonId)] });
    }

    const key = interaction.options.getString('tipo', true);
    const doc = await categoryLeaderboard(key, seasonId);
    return interaction.editReply({ embeds: [renderCategory(key, doc, seasonId)] });
  },
};
