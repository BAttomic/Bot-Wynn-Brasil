import { SlashCommandBuilder } from 'discord.js';
import { getActiveSeason } from '../../services/seasons.js';
import { pointsLeaderboard } from '../../services/points.js';

const MEDALS = ['🥇', '🥈', '🥉'];

// Serve o placar materializado. Ele é reconstruído uma vez por dia, junto do
// snapshot — não consulta guildStats ao vivo de propósito.
function render(title, doc) {
  const lines = doc.rows.map((r, i) => {
    const badge = MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``;
    return `${badge} **${r.username}** — ${r.points} pts · ⚔ ${r.guildWars} · 🛡️ ${r.guildRaids}`;
  });
  return {
    embeds: [
      {
        title,
        description: lines.join('\n'),
        color: 0xf1c40f,
        footer: { text: 'Apurado uma vez por dia · pts · guerras · guild raids' },
        timestamp: doc.builtAt ? new Date(doc.builtAt).toISOString() : undefined,
      },
    ],
  };
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Placar da guilda (apurado 1x por dia)')
    .addSubcommand((s) =>
      s
        .setName('season')
        .setDescription('Placar da season (padrão: ativa)')
        .addStringOption((o) => o.setName('id').setDescription('ID da season').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('alltime').setDescription('Placar acumulado (todas as seasons)'))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();

    if (sub === 'season') {
      let seasonId = interaction.options.getString('id');
      if (!seasonId) {
        const s = await getActiveSeason();
        if (!s) return interaction.editReply('Não há season ativa. Use `/season start`.');
        seasonId = s.seasonId;
      }
      const doc = await pointsLeaderboard('season', seasonId);
      if (!doc.rows.length) {
        return interaction.editReply(`Ninguém pontuou na season **${seasonId}** ainda.`);
      }
      return interaction.editReply(render(`🏆 Leaderboard — Season ${seasonId}`, doc));
    }

    const doc = await pointsLeaderboard('alltime');
    if (!doc.rows.length) {
      return interaction.editReply('Ainda não há pontos apurados. O placar é montado na apuração diária.');
    }
    return interaction.editReply(render('🏆 Leaderboard — Acumulado', doc));
  },
};
