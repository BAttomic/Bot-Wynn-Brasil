import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { startSeason, endActiveSeason, getActiveSeason, listSeasons } from '../../services/seasons.js';
import { audit } from '../../services/audit.js';

export default {
  data: new SlashCommandBuilder()
    .setName('season')
    .setDescription('Gerencia as temporadas (seasons) da guilda')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('start')
        .setDescription('Inicia uma nova season (encerra a atual)')
        .addStringOption((o) => o.setName('id').setDescription('Nome/ID da season').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('end').setDescription('Encerra a season ativa'))
    .addSubcommand((s) => s.setName('current').setDescription('Mostra a season ativa'))
    .addSubcommand((s) => s.setName('list').setDescription('Lista as seasons'))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'start') {
      const id = interaction.options.getString('id', true).trim();
      const s = await startSeason(id);
      audit(interaction.client, interaction.guildId, `🏁 Season **${s.seasonId}** iniciada por <@${interaction.user.id}>.`);
      return interaction.editReply(`Season **${s.seasonId}** iniciada.`);
    }
    if (sub === 'end') {
      const s = await endActiveSeason();
      if (!s) return interaction.editReply('Não há season ativa.');
      audit(interaction.client, interaction.guildId, `🏁 Season **${s.seasonId}** encerrada por <@${interaction.user.id}>.`);
      return interaction.editReply(`Season **${s.seasonId}** encerrada.`);
    }
    if (sub === 'current') {
      const s = await getActiveSeason();
      return interaction.editReply(s ? `Season ativa: **${s.seasonId}** (desde <t:${Math.floor(new Date(s.startAt).getTime() / 1000)}:D>).` : 'Nenhuma season ativa.');
    }
    // list
    const seasons = await listSeasons();
    if (!seasons.length) return interaction.editReply('Nenhuma season registrada.');
    const lines = seasons.map((s) => `• **${s.seasonId}** ${s.active ? '(ativa)' : ''} — início <t:${Math.floor(new Date(s.startAt).getTime() / 1000)}:d>`);
    return interaction.editReply(lines.join('\n'));
  },
};
