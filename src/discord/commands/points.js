import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getActiveSeason } from '../../services/seasons.js';
import { awardPoints, pointsLeaderboard } from '../../services/points.js';
import { audit } from '../../services/audit.js';

const MEDALS = ['🥇', '🥈', '🥉'];

async function resolveUuid(discordId) {
  const m = await collections.members().findOne({ discordId });
  return m?.uuid ? { uuid: m.uuid, username: m.username } : null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('points')
    .setDescription('Sistema de pontos da guilda')
    .addSubcommand((s) =>
      s.setName('show').setDescription('Mostra os pontos de um membro').addStringOption((o) => o.setName('nick').setDescription('Nick (padrão: você)').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('leaderboard').setDescription('Ranking por pontos').addStringOption((o) => o.setName('season').setDescription('ID da season (padrão: acumulado)').setRequired(false)))
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('(Staff) Concede pontos manuais (ex.: evento)')
        .addUserOption((o) => o.setName('user').setDescription('Membro').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Quantidade (use negativo para remover)').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivo').setRequired(true)),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: interaction.options.getSubcommand() === 'add' });
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.editReply('Apenas staff pode conceder pontos.');
      }
      const user = interaction.options.getUser('user', true);
      const amount = interaction.options.getInteger('amount', true);
      const reason = interaction.options.getString('reason', true);
      const info = await resolveUuid(user.id);
      if (!info) return interaction.editReply('Esse usuário não está vinculado (`/link`).');
      await awardPoints(info.uuid, info.username, amount, reason);
      audit(interaction.client, interaction.guildId, `⭐ ${amount >= 0 ? '+' : ''}${amount} pts para **${info.username}** (${reason}) por <@${interaction.user.id}>.`);
      return interaction.editReply(`\`${amount >= 0 ? '+' : ''}${amount}\` pontos para **${info.username}**.`);
    }

    if (sub === 'leaderboard') {
      let seasonId = interaction.options.getString('season');
      const scope = seasonId ? 'season' : 'alltime';
      if (scope === 'season' && seasonId === 'atual') {
        const s = await getActiveSeason();
        seasonId = s?.seasonId;
      }
      const rows = await pointsLeaderboard(scope, seasonId);
      if (!rows.length) return interaction.editReply('Ainda não há pontos registrados.');
      const lines = rows.map((r, i) => `${MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``} **${r.username}** — ${r.points} pts`);
      return interaction.editReply({
        embeds: [{ title: `⭐ Ranking de Pontos${scope === 'season' ? ` — Season ${seasonId}` : ' — Acumulado'}`, description: lines.join('\n'), color: 0xf1c40f }],
      });
    }

    // show
    const nick = interaction.options.getString('nick');
    let stats;
    if (nick) {
      stats = await collections.guildStats().findOne({ username: new RegExp(`^${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    } else {
      const info = await resolveUuid(interaction.user.id);
      if (!info) return interaction.editReply('Você não está vinculado (`/link`).');
      stats = await collections.guildStats().findOne({ uuid: info.uuid });
    }
    if (!stats) return interaction.editReply('Nenhum ponto encontrado para esse jogador.');

    const season = await getActiveSeason();
    let seasonPts = 0;
    if (season) {
      const sp = await collections.seasonParticipation().findOne({ seasonId: season.seasonId, uuid: stats.uuid });
      seasonPts = sp?.points ?? 0;
    }
    return interaction.editReply({
      embeds: [{
        title: `⭐ Pontos — ${stats.username}`,
        color: 0xf1c40f,
        fields: [
          { name: 'Acumulado', value: String(stats.points ?? 0), inline: true },
          { name: `Season ${season?.seasonId ?? '-'}`, value: String(seasonPts), inline: true },
          { name: 'Guerras', value: String(stats.guildWars ?? 0), inline: true },
          { name: 'Raids', value: String(stats.guildRaids ?? 0), inline: true },
        ],
      }],
    });
  },
};
