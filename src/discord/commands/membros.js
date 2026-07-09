import { SlashCommandBuilder } from 'discord.js';
import { fetchGuildMembers, RANKS } from '../../services/guildData.js';
import { getConfig } from '../../config/guildConfig.js';
import { optional } from '../../config/env.js';

const LABEL = {
  owner: 'Líder',
  chief: 'Sub-líder',
  strategist: 'Estrategista',
  captain: 'Capitão',
  recruiter: 'Recrutador',
  recruit: 'Recruta',
};

function daysSince(date) {
  if (!date) return null;
  return Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
}

function cap(s, max = 800) {
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

export default {
  data: new SlashCommandBuilder()
    .setName('membros')
    .setDescription('Lista os membros da guilda por cargo e destaca inativos')
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const prefix = optional('WYNN_GUILD_PREFIX');
    const res = await fetchGuildMembers(prefix);
    if (!res) return interaction.editReply('Não consegui obter os membros da guilda.');

    const cfg = await getConfig(interaction.guildId);
    const inactivityDays = Number(cfg.params?.inactivityDays) || 7;

    const byRank = Object.fromEntries(RANKS.map((r) => [r, []]));
    for (const m of res.members) byRank[m.rank].push(m);

    const fields = [];
    for (const r of RANKS) {
      const list = byRank[r];
      if (!list.length) continue;
      const online = list.filter((m) => m.online).length;
      const val = cap(list.map((m) => `${m.online ? '🟢' : '⚫'} ${m.username}`).join(', '));
      fields.push({ name: `${LABEL[r]} — ${list.length} (🟢 ${online})`, value: val });
    }

    const inactive = res.members
      .map((m) => ({ username: m.username, d: daysSince(m.lastJoin), online: m.online }))
      .filter((m) => m.d != null && m.d >= inactivityDays && !m.online)
      .sort((a, b) => b.d - a.d);
    const inactiveVal = inactive.length
      ? cap(inactive.map((m) => `**${m.username}** — ${m.d}d`).join('\n'))
      : 'Nenhum 🎉';
    fields.push({ name: `💤 Inativos (${inactivityDays}d+)`, value: inactiveVal });

    return interaction.editReply({
      embeds: [
        {
          title: `Membros — ${res.guild.name} [${res.guild.prefix}] (${res.guild.members.total})`,
          color: 0x2ecc71,
          fields,
          footer: { text: 'Dados da API Wynncraft' },
        },
      ],
    });
  },
};
