import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getActiveSeason } from '../../services/seasons.js';
import {
  awardPoints,
  pointsLeaderboard,
  recomputePoints,
  rebuildLeaderboards,
  recordWeeklyCompletion,
  reconcileWeeklyLedger,
} from '../../services/points.js';
import { fetchGuildMembers } from '../../services/guildData.js';
import { tomeCredits } from '../../services/tomes.js';
import { optional } from '../../config/env.js';
import { ensureLeaderboardPanel, PAGE_SIZE } from '../../services/leaderboardPanel.js';
import { runProgressSnapshot } from '../../jobs/progressSnapshot.js';
import { audit } from '../../services/audit.js';

const MEDALS = ['🥇', '🥈', '🥉'];
// O ranking inteiro não cabe num embed (o limite é 4096 caracteres), então o
// comando fatia igual ao painel. Sem página pedida, mostra a primeira.
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
    .addSubcommand((s) =>
      s
        .setName('leaderboard')
        .setDescription('Ranking por pontos')
        .addStringOption((o) => o.setName('season').setDescription('ID da season (padrão: acumulado)').setRequired(false))
        .addIntegerOption((o) =>
          o
            .setName('pagina')
            .setDescription(`Página do ranking (${PAGE_SIZE} por página)`)
            .setMinValue(1)
            .setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('(Staff) Concede pontos manuais (ex.: evento)')
        .addUserOption((o) => o.setName('user').setDescription('Membro').setRequired(true))
        .addIntegerOption((o) => o.setName('amount').setDescription('Quantidade (use negativo para remover)').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Motivo').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('recalcular')
        .setDescription('(Staff) Recalcula todo o histórico com os pesos atuais e refaz o ranking'),
    )
    .addSubcommand((s) =>
      s
        .setName('apurar')
        .setDescription('(Staff) Roda a apuração agora, sem esperar o horário diário'),
    )
    .addSubcommand((s) =>
      s
        .setName('semanal')
        .setDescription('(Staff) Credita objetivos semanais que ficaram sem contar (desta semana e da sequência)'),
    )
    .toJSON(),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: sub !== 'show' && sub !== 'leaderboard' });

    if (sub === 'apurar') {
      // Snapshot + eventos + recompute + tabelas, exatamente o que o job diário faz.
      await runProgressSnapshot(interaction.client);
      await ensureLeaderboardPanel(interaction.client, interaction.guildId);
      const total = await collections.guildStats().countDocuments({ points: { $gt: 0 } });
      audit(interaction.client, interaction.guildId, `📸 <@${interaction.user.id}> forçou a apuração.`);
      return interaction.editReply(
        `Apuração concluída. **${total}** membro(s) com pontos.\n-# A primeira apuração cria a linha de base: XP contribuído e guild raids entram por inteiro. Guerras e objetivos semanais só contam daqui em diante.`,
      );
    }

    if (sub === 'semanal') {
      // O watcher já credita sozinho; isto é para conferir e cobrir quem ficou
      // de fora. Quem já tem o crédito desta semana não dobra
      // (recordWeeklyCompletion recusa a mesma sequência em 7 dias).
      if (!optional('WYNN_API_KEY')) {
        return interaction.editReply(
          '⚠️ A `WYNN_API_KEY` não está configurada no ambiente do bot. Sem ela a API não mostra o objetivo semanal e **nenhum** é contado. Configure a variável no Dokploy e faça o redeploy.',
        );
      }
      const res = await fetchGuildMembers(optional('WYNN_GUILD_PREFIX'));
      if (!res) return interaction.editReply('Não consegui buscar a guilda na API. Tente de novo em instantes.');
      const conhecidos = res.members.filter((m) => m.weeklyCompleted !== null);
      if (!conhecidos.length) {
        return interaction.editReply(
          '⚠️ A `WYNN_API_KEY` está configurada, mas a API não devolve o objetivo semanal: a chave precisa ser de um **membro desta guilda**, ou foi revogada. Enquanto isso, **nenhum** objetivo é contado.',
        );
      }
      const creditados = [];
      const jaTinham = [];
      const fizeram = conhecidos.filter((c) => c.weeklyCompleted);
      for (const m of fizeram) {
        const novo = await recordWeeklyCompletion({ uuid: m.uuid, username: m.username, streak: m.weeklyStreak });
        (novo ? creditados : jaTinham).push(m.username);
      }
      // As semanas ANTERIORES que a sequência prova e o livro-razão não tem. O
      // watcher faz o mesmo sozinho a cada boot; aqui é para não esperar.
      const recuperadas = await reconcileWeeklyLedger(conhecidos);
      // Tem semanal contada e mesmo assim não tem Tome: já recebeu mais Tomes do
      // que semanais contadas. A regra quita esse excedente antes de dar direito
      // de novo; quem decide se corrige é a staff.
      const afetados = new Set([...fizeram.map((m) => m.uuid), ...recuperadas.map((r) => r.uuid)]);
      const stats = await collections
        .guildStats()
        .find({ uuid: { $in: [...afetados] } }, { projection: { username: 1, weeklyObjectives: 1, tomesDelivered: 1 } })
        .toArray();
      const semTome = stats
        .filter((s) => tomeCredits(s) <= 0)
        .map((s) => `${s.username} (${s.tomesDelivered ?? 0} recebidos / ${s.weeklyObjectives ?? 0} contadas)`);
      if (creditados.length || recuperadas.length) {
        await rebuildLeaderboards();
        await ensureLeaderboardPanel(interaction.client, interaction.guildId);
        const partes = [
          creditados.length && `desta semana: ${creditados.join(', ')}`,
          recuperadas.length && `anteriores, pela sequência: ${recuperadas.map((r) => `${r.username} +${r.added}`).join(', ')}`,
        ].filter(Boolean);
        audit(interaction.client, interaction.guildId, `📅 <@${interaction.user.id}> creditou objetivos semanais — ${partes.join(' · ')}.`);
      }
      const lista = (nomes) => (nomes.length ? nomes.join(', ').slice(0, 1000) : 'Ninguém');
      return interaction.editReply({
        embeds: [{
          title: '📅 Objetivo semanal',
          color: 0x1abc9c,
          fields: [
            { name: `✅ Desta semana, creditados agora (${creditados.length})`, value: lista(creditados) },
            { name: `☑️ Desta semana, já tinham o crédito (${jaTinham.length})`, value: lista(jaTinham) },
            {
              name: `🔁 Semanas anteriores recuperadas pela sequência (${recuperadas.length})`,
              value: recuperadas.length
                ? lista(recuperadas.map((r) => `${r.username} +${r.added}`))
                : 'Nenhuma faltando: o livro-razão já bate com a sequência de todo mundo.',
            },
            ...(semTome.length
              ? [{
                  name: `📜 Com semanal contada, mas sem Tome (${semTome.length})`,
                  value: `${lista(semTome)}\n-# Já receberam mais Tomes do que semanais contadas. Se foram semanais que o bot perdeu, ajuste com \`/tome corrigir\`.`.slice(0, 1024),
                }]
              : []),
          ],
          footer: { text: `${creditados.length + jaTinham.length} de ${conhecidos.length} membros fizeram o desta semana` },
        }],
      });
    }

    if (sub === 'recalcular') {
      const { members } = await recomputePoints();
      await rebuildLeaderboards();
      await ensureLeaderboardPanel(interaction.client, interaction.guildId);
      audit(interaction.client, interaction.guildId, `♻️ <@${interaction.user.id}> recalculou os pontos (${members} membros).`);
      return interaction.editReply(`Histórico reprocessado com os pesos atuais: **${members}** membro(s). Ranking e painel refeitos.`);
    }

    if (sub === 'add') {
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
      const { rows, builtAt } = await pointsLeaderboard(scope, seasonId);
      if (!rows.length) return interaction.editReply('Ainda não há pontos registrados.');
      const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      const page = Math.min(Math.max(0, (interaction.options.getInteger('pagina') ?? 1) - 1), pages - 1);
      const inicio = page * PAGE_SIZE;
      // A numeração segue a posição REAL: a página 2 começa no 21, não no 1.
      const lines = rows.slice(inicio, inicio + PAGE_SIZE).map((r, i) => `${MEDALS[inicio + i] || `\`${String(inicio + i + 1).padStart(2, ' ')}\``} **${r.username}** — \`${Number(r.points).toLocaleString('pt-BR')}\` pts`);
      return interaction.editReply({
        embeds: [{
          title: `⭐ Ranking de Pontos${scope === 'season' ? ` — Season ${seasonId}` : ' — Acumulado'}`,
          description: lines.join('\n'),
          color: 0xf1c40f,
          footer: { text: `Apurado uma vez por dia${pages > 1 ? ` · página ${page + 1}/${pages}` : ''}` },
          timestamp: builtAt ? new Date(builtAt).toISOString() : undefined,
        }],
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
          { name: 'Guild Raids', value: String(stats.guildRaids ?? 0), inline: true },
          { name: 'Raids (todas)', value: String(stats.raidsInGuild ?? 0), inline: true },
        ],
      }],
    });
  },
};
