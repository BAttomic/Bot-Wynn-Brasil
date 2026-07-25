import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getActiveSeason } from '../../services/seasons.js';
import {
  pointsLeaderboard,
  categoryLeaderboard,
  recomputePoints,
  rebuildLeaderboards,
  CATEGORIES,
} from '../../services/points.js';
import {
  SELECT_ID,
  ME_ID,
  SKIN_ID,
  CAPE_ID,
  MODPACK_ID,
  handleLeaderboardSelect,
  handleMyPoints,
  handleAssetDownload,
  ensureLeaderboardPanel,
  renderPoints,
  renderCategory,
} from '../../services/leaderboardPanel.js';
import { modpackReply } from './modpack.js';

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
        .setName('atualizar')
        .setDescription('(Staff) Reapura o placar agora e republica o painel'),
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
    return [SELECT_ID, ME_ID, SKIN_ID, CAPE_ID, MODPACK_ID].includes(interaction.customId);
  },

  handleComponent(interaction) {
    if (interaction.customId === ME_ID) return handleMyPoints(interaction);
    if (interaction.customId === SKIN_ID) return handleAssetDownload(interaction, 'uniforme');
    if (interaction.customId === CAPE_ID) return handleAssetDownload(interaction, 'capa');
    if (interaction.customId === MODPACK_ID) return interaction.reply(modpackReply());
    return handleLeaderboardSelect(interaction);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'atualizar') {
      await interaction.deferReply({ ephemeral: true });
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply('Apenas staff pode forçar a apuração.');
      }
      // Recalcula do livro-razão, remonta as tabelas e reedita o painel fixo.
      const { members } = await recomputePoints();
      const { categories } = await rebuildLeaderboards();
      await ensureLeaderboardPanel(interaction.client, interaction.guildId);
      return interaction.editReply(
        `Placar reapurado: **${members}** membro(s), pontos + ${categories} categorias. Painel atualizado.`,
      );
    }

    await interaction.deferReply();
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
