import { SlashCommandBuilder } from 'discord.js';
import { getActiveSeason } from '../../services/seasons.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from '../../services/points.js';
import { shortNumber } from '../../util/format.js';

const MEDALS = ['🥇', '🥈', '🥉'];

const badge = (i) => MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``;

function footer(seasonId) {
  return { text: `${seasonId ? `Season ${seasonId}` : 'Acumulado'} · apurado uma vez por dia` };
}

// Resolve a season pedida. `atual` (ou vazio no subcomando season) usa a ativa.
async function resolveSeason(raw) {
  if (!raw) return null;
  if (raw.toLowerCase() === 'atual') return (await getActiveSeason())?.seasonId ?? null;
  return raw;
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Placar da guilda (apurado 1x por dia)')
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
            .addChoices(
              ...Object.entries(CATEGORIES).map(([value, c]) => ({ name: c.label, value })),
            ),
        )
        .addStringOption((o) =>
          o.setName('season').setDescription('ID da season, ou "atual" (padrão: acumulado)').setRequired(false),
        ),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    const seasonId = await resolveSeason(interaction.options.getString('season'));

    if (sub === 'pontos') {
      const doc = await pointsLeaderboard(seasonId ? 'season' : 'alltime', seasonId);
      if (!doc.rows.length) {
        return interaction.editReply(
          seasonId
            ? `Ninguém pontuou na season **${seasonId}** ainda.`
            : 'Ainda não há pontos apurados. O placar é montado na apuração diária — a staff pode forçar com `/points recalcular`.',
        );
      }
      const lines = doc.rows.map(
        (r, i) => `${badge(i)} **${r.username}** — ${r.points} pts · ⚔ ${r.guildWars} · 🛡️ ${r.guildRaids}`,
      );
      return interaction.editReply({
        embeds: [{
          title: '🏆 Pontos de contribuição',
          description: lines.join('\n'),
          color: 0xf1c40f,
          footer: footer(seasonId),
          timestamp: doc.builtAt ? new Date(doc.builtAt).toISOString() : undefined,
        }],
      });
    }

    // categoria
    const key = interaction.options.getString('tipo', true);
    const cat = CATEGORIES[key];
    const doc = await categoryLeaderboard(key, seasonId);
    if (!doc.rows.length) {
      return interaction.editReply(`Ninguém pontuou em **${cat.label}**${seasonId ? ` na season ${seasonId}` : ''} ainda.`);
    }

    const fmt = (v) => (cat.short ? shortNumber(v) : v.toLocaleString('pt-BR'));
    const lines = doc.rows.map((r, i) => `${badge(i)} **${r.username}** — \`${fmt(r.value)}\` ${cat.unit}`);

    return interaction.editReply({
      embeds: [{
        title: `${cat.emoji} ${cat.label}`,
        description: lines.join('\n'),
        color: 0x3498db,
        footer: footer(seasonId),
        timestamp: doc.builtAt ? new Date(doc.builtAt).toISOString() : undefined,
      }],
    });
  },
};
