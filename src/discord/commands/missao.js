import { SlashCommandBuilder } from 'discord.js';
import { fetchGuildMembers } from '../../services/guildData.js';
import { optional } from '../../config/env.js';

// A missão semanal só existe na resposta AUTENTICADA da API, e só para a guilda
// dona da chave. Sem WYNN_API_KEY, a API devolve `weekly: {}` para todo mundo e
// não há como distinguir "não fez" de "não sei".
function block(names, max = 1000) {
  if (!names.length) return 'Ninguém';
  const s = names.join(', ');
  return s.length > max ? `${s.slice(0, max)} …` : s;
}

export default {
  data: new SlashCommandBuilder()
    .setName('missao')
    .setDescription('Quem fez a missão semanal da guilda')
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();

    if (!optional('WYNN_API_KEY')) {
      return interaction.editReply(
        'A missão semanal só vem na API autenticada. Configure `WYNN_API_KEY` no ambiente do bot.',
      );
    }

    const prefix = optional('WYNN_GUILD_PREFIX');
    const res = await fetchGuildMembers(prefix);
    if (!res) return interaction.editReply('Não consegui buscar a guilda na API.');

    const conhecidos = res.members.filter((m) => m.weeklyCompleted !== null);
    if (!conhecidos.length) {
      return interaction.editReply(
        'A API não devolveu a missão semanal. A chave precisa pertencer a um membro desta guilda.',
      );
    }

    const fizeram = conhecidos.filter((m) => m.weeklyCompleted);
    const faltam = conhecidos.filter((m) => !m.weeklyCompleted);

    const comStreak = [...conhecidos]
      .filter((m) => m.weeklyStreak > 0)
      .sort((a, b) => b.weeklyStreak - a.weeklyStreak)
      .slice(0, 10)
      .map((m, i) => `\`${String(i + 1).padStart(2, ' ')}.\` **${m.username}** — ${m.weeklyStreak} semana(s)`);

    return interaction.editReply({
      embeds: [
        {
          title: '📅 Missão semanal da guilda',
          color: 0x1abc9c,
          fields: [
            { name: `✅ Fizeram (${fizeram.length})`, value: block(fizeram.map((m) => m.username)) },
            { name: `⌛ Faltam (${faltam.length})`, value: block(faltam.map((m) => m.username)) },
            ...(comStreak.length ? [{ name: '🔥 Maiores sequências', value: comStreak.join('\n') }] : []),
          ],
          footer: { text: `${res.guild.name} [${res.guild.prefix}] — dados da API autenticada` },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
};
