import { SlashCommandBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { fetchGuildMembers, RANKS, RANK_LABEL } from '../../services/guildData.js';
import { evaluate } from '../../services/inactivity.js';
import { getConfig } from '../../config/guildConfig.js';
import { optional } from '../../config/env.js';

/** Corta um texto longo para caber num campo de embed (limite 1024). */
function cap(s, max = 800) {
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

export default {
  data: new SlashCommandBuilder()
    .setName('membros')
    .setDescription('Lista os membros da guilda por cargo e quem já pode ser expulso por inatividade')
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();
    const prefix = optional('WYNN_GUILD_PREFIX');
    const res = await fetchGuildMembers(prefix);
    if (!res) return interaction.editReply('Não consegui obter os membros da guilda.');

    const cfg = await getConfig(interaction.guildId);
    const params = cfg.params;

    const stats = await collections.guildStats().find({}, { projection: { uuid: 1, points: 1 } }).toArray();
    const pointsByUuid = new Map(stats.map((s) => [s.uuid, s.points ?? 0]));

    const byRank = Object.fromEntries(RANKS.map((r) => [r, []]));
    for (const m of res.members) byRank[m.rank].push(m);

    const fields = [];
    for (const r of RANKS) {
      const list = byRank[r];
      if (!list.length) continue;
      const online = list.filter((m) => m.online).length;
      const val = cap(list.map((m) => `${m.online ? '🟢' : '⚫'} ${m.username}`).join(', '));
      fields.push({ name: `${RANK_LABEL[r]} — ${list.length} (🟢 ${online})`, value: val });
    }

    // Cada membro é medido contra o PRÓPRIO limite: base + perdão pela contribuição.
    const avaliados = res.members
      .map((m) => evaluate(m, pointsByUuid.get(m.uuid) ?? 0, params))
      .sort((a, b) => (b.offline ?? 0) - (a.offline ?? 0));

    const expulsaveis = avaliados.filter((r) => r.kickable);
    const protegidos = avaliados.filter(
      (r) => !r.kickable && r.offline !== null && r.offline >= params.inactivityDays,
    );

    fields.push({
      name: `⛔ Já podem ser expulsos (${expulsaveis.length})`,
      value: expulsaveis.length
        ? cap(expulsaveis.map((r) => `**${r.username}** — ${r.offline}d offline / limite ${r.allowance}d`).join('\n'))
        : 'Nenhum 🎉',
    });

    if (protegidos.length) {
      fields.push({
        name: `🛡️ Inativos, mas protegidos pela contribuição (${protegidos.length})`,
        value: cap(
          protegidos
            .map((r) => `**${r.username}** — ${r.offline}d offline · limite ${r.allowance}d (+${r.forgiveness}d por ${r.points} pts)`)
            .join('\n'),
        ),
      });
    }

    return interaction.editReply({
      embeds: [
        {
          title: `Membros — ${res.guild.name} [${res.guild.prefix}] (${res.guild.members.total})`,
          color: 0x2ecc71,
          fields,
          footer: {
            text: `Limite base ${params.inactivityDays}d · +1d a cada ${params.inactivityForgivenessPerPoints} pts (máx +${params.inactivityForgivenessMaxDays}d)`,
          },
        },
      ],
    });
  },
};
