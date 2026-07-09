import { SlashCommandBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getActiveSeason } from '../../services/seasons.js';

const MEDALS = ['🥇', '🥈', '🥉'];

function rankLine(i, name, value, unit) {
  const badge = MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``;
  return `${badge} **${name}** — ${value} ${unit}`;
}

export default {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Placar de guerras pela guilda')
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
      const rows = await collections
        .seasonParticipation()
        .find({ seasonId, warsFought: { $gt: 0 } })
        .sort({ warsFought: -1 })
        .limit(15)
        .toArray();
      if (!rows.length) return interaction.editReply(`Ninguém pontuou guerras na season **${seasonId}** ainda.`);
      const lines = rows.map((r, i) => rankLine(i, r.username, r.warsFought, 'guerras'));
      return interaction.editReply({
        embeds: [{ title: `🏆 Leaderboard — Season ${seasonId}`, description: lines.join('\n'), color: 0xf1c40f }],
      });
    }

    // alltime
    const rows = await collections
      .guildStats()
      .find({ guildWars: { $gt: 0 } })
      .sort({ guildWars: -1 })
      .limit(15)
      .toArray();
    if (!rows.length) return interaction.editReply('Ainda não há guerras contabilizadas.');
    const lines = rows.map((r, i) => rankLine(i, r.username, r.guildWars, 'guerras'));
    return interaction.editReply({
      embeds: [{ title: '🏆 Leaderboard — Acumulado', description: lines.join('\n'), color: 0xf1c40f }],
    });
  },
};
