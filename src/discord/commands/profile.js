import { SlashCommandBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';

const RANK_LABEL = {
  owner: 'Líder',
  chief: 'Sub-líder',
  strategist: 'Estrategista',
  captain: 'Capitão',
  recruiter: 'Recrutador',
  recruit: 'Recruta',
};

const ts = (d, style = 'R') => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:${style}>` : '—');

export default {
  data: new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Perfil detalhado de um jogador + progresso na guilda')
    .addStringOption((o) => o.setName('nick').setDescription('Nick (padrão: você)').setRequired(false))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    let nick = interaction.options.getString('nick');
    if (!nick) {
      const me = await collections.members().findOne({ discordId: interaction.user.id });
      if (!me) return interaction.editReply('Você não está vinculado. Use `/link` ou informe um nick.');
      nick = me.username;
    }

    const p = await wynn.player(nick);
    if (!p || !p.uuid) return interaction.editReply(`Não encontrei o jogador **${nick}**.`);
    const stats = await collections.guildStats().findOne({ uuid: p.uuid });
    const link = await collections.members().findOne({ uuid: p.uuid });
    const g = p.globalData || {};

    const lines = [];
    lines.push(`**🆔 UUID:** \`${p.uuid}\``);
    lines.push(`**📅 Último login:** ${p.online ? '`Online`' : ts(p.lastJoin)}`);
    if (p.guild) {
      lines.push(`**🛡️ Guilda:** \`${p.guild.name} [${p.guild.prefix}]\` — ${RANK_LABEL[p.guild.rank?.toLowerCase()] || p.guild.rank}`);
    }
    lines.push('');
    lines.push('**Estatísticas globais:**');
    lines.push(`- ⚔ Guerras: \`${g.wars ?? 0}\` · 📈 Nível total: \`${g.totalLevel ?? 0}\``);
    lines.push(`- 🏰 Dungeons: \`${g.dungeons?.total ?? 0}\` · 🚀 Raids: \`${g.raids?.total ?? 0}\``);
    lines.push(`- 🏆 Quests: \`${g.completedQuests ?? 0}\` · ⏳ \`${Number(p.playtime || 0).toFixed(1)}h\``);
    if (g.pvp) lines.push(`- 🗡️ PvP: \`${g.pvp.kills ?? 0}\` kills / \`${g.pvp.deaths ?? 0}\` mortes`);
    lines.push('');
    lines.push('**Na nossa guilda (rastreado):**');
    lines.push(`- ⭐ Pontos: \`${stats?.points ?? 0}\` · ⚔ Guerras: \`${stats?.guildWars ?? 0}\` · 🛡️ Guild Raids: \`${stats?.guildRaids ?? 0}\``);
    if (link?.peakRank) {
      const peak = RANK_LABEL[link.peakRank] ?? link.peakRank;
      const back = link.guildRank && link.guildRank !== link.peakRank ? ' — pode ser restaurado' : '';
      lines.push(`- 🥇 Cargo mais alto já alcançado: \`${peak}\`${back}`);
    }
    lines.push(`- 📅 Primeira entrada no jogo: ${ts(p.firstJoin, 'D')}`);

    return interaction.editReply({
      embeds: [
        {
          title: `Perfil — ${p.username}`,
          color: 0x3498db,
          thumbnail: p.rankBadge ? { url: `https://cdn.wynncraft.com/${p.rankBadge}` } : undefined,
          description: lines.join('\n'),
          footer: { text: 'Dados da API Wynncraft' },
        },
      ],
    });
  },
};
