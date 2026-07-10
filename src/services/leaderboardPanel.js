import { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from './points.js';
import { allowanceDays, forgivenessDays, daysOffline } from './inactivity.js';
import { wynn } from '../wynn/api.js';
import { shortNumber } from '../util/format.js';

export const SELECT_ID = 'lb:view';
export const ME_ID = 'lb:me';
const STATE_ID = 'leaderboardPanel';
const MEDALS = ['🥇', '🥈', '🥉'];

const badge = (i) => MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``;

function stamp(doc, seasonId) {
  return {
    footer: { text: `${seasonId ? `Season ${seasonId}` : 'Acumulado'} · apurado uma vez por dia · top 15` },
    timestamp: doc.builtAt ? new Date(doc.builtAt).toISOString() : undefined,
  };
}

/**
 * @param {{rows?: object[], builtAt?: Date}} doc  documento do cache
 * @param {string|null} seasonId
 * @returns {import('discord.js').APIEmbed}
 */
export function renderPoints(doc, seasonId = null) {
  const rows = doc?.rows ?? [];
  if (!rows.length) {
    return { title: '🏆 Pontos de contribuição', color: 0xf1c40f, description: 'Ainda não há pontos apurados.' };
  }
  const lines = rows.map(
    (r, i) => `${badge(i)} **${r.username}** — ${r.points} pts · ⚔ ${r.guildWars} · 🛡️ ${r.guildRaids}`,
  );
  return { title: '🏆 Pontos de contribuição', color: 0xf1c40f, description: lines.join('\n'), ...stamp(doc, seasonId) };
}

/**
 * @param {string} key  chave de CATEGORIES
 * @param {{rows?: object[], builtAt?: Date}} doc
 * @param {string|null} seasonId
 * @returns {import('discord.js').APIEmbed}
 */
export function renderCategory(key, doc, seasonId = null) {
  const cat = CATEGORIES[key];
  if (!cat) return { title: 'Ranking desconhecido', color: 0xe74c3c, description: 'Essa categoria não existe.' };

  const rows = doc?.rows ?? [];
  if (!rows.length) {
    return { title: `${cat.emoji} ${cat.label}`, color: 0x3498db, description: 'Ninguém pontuou aqui ainda.' };
  }
  const fmt = (v) => (cat.short ? shortNumber(v) : Number(v).toLocaleString('pt-BR'));
  const lines = rows.map((r, i) => `${badge(i)} **${r.username}** — \`${fmt(r.value)}\` ${cat.unit}`);
  return { title: `${cat.emoji} ${cat.label}`, color: 0x3498db, description: lines.join('\n'), ...stamp(doc, seasonId) };
}

function selectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Ver outro ranking…')
    .addOptions(
      { label: 'Pontos de contribuição', value: 'pontos', emoji: '🏆', description: 'O ranking geral (padrão)' },
      ...Object.entries(CATEGORIES).map(([value, c]) => ({
        label: c.label,
        value,
        emoji: c.emoji,
        description: `Números crus de ${c.unit}`,
      })),
    );
  return new ActionRowBuilder().addComponents(menu);
}

function meRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ME_ID)
      .setLabel('Meus pontos')
      .setEmoji('⭐')
      .setStyle(ButtonStyle.Primary),
  );
}

export async function buildLeaderboardPanel() {
  const doc = await pointsLeaderboard('alltime');
  return { embeds: [renderPoints(doc)], components: [selectRow(), meRow()] };
}

/**
 * Ficha pessoal: pontos, posição e a margem de inatividade que eles compram.
 * Responde só a quem clicou.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleMyPoints(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const linked = await collections.members().findOne({ discordId: interaction.user.id });
  if (!linked) return interaction.editReply('Você ainda não vinculou sua conta no canal de registro.');

  const stats = await collections.guildStats().findOne({ uuid: linked.uuid });
  const points = stats?.points ?? 0;

  // Posição = quantos têm mais pontos que você, +1.
  const acima = await collections.guildStats().countDocuments({ points: { $gt: points } });

  const { params } = await getConfig(interaction.guildId);
  const limite = allowanceDays(points, params);
  const perdao = forgivenessDays(points, params);

  // lastJoin não fica no banco; vem da API (com cache).
  const player = await wynn.player(linked.username).catch(() => null);
  const offline = daysOffline(player?.lastJoin);
  const online = !!player?.online;

  const linhas = [
    `**Pontos:** \`${points}\` · **Posição:** \`#${acima + 1}\``,
    `⚔ Guerras \`${stats?.guildWars ?? 0}\` · 🛡️ Guild Raids \`${stats?.guildRaids ?? 0}\` · 📅 Semanais \`${stats?.weeklyObjectives ?? 0}\``,
    `📈 Guild XP contribuído: \`${shortNumber(stats?.contributed ?? 0)}\``,
    '',
    `**Margem de inatividade:** \`${limite} dias\` (${params.inactivityDays} base + ${perdao} de perdão)`,
  ];

  if (online) linhas.push('🟢 Você está online agora.');
  else if (offline !== null) {
    const sobra = limite - offline;
    linhas.push(
      sobra >= 0
        ? `⚫ Offline há \`${offline}\` dia(s). Ainda restam \`${sobra}\` dia(s).`
        : `🔴 Offline há \`${offline}\` dia(s) — **acima do seu limite**.`,
    );
  }

  return interaction.editReply({
    embeds: [
      {
        title: `⭐ ${linked.username}`,
        color: 0xf1c40f,
        description: linhas.join('\n'),
        thumbnail: { url: `https://visage.surgeplay.com/bust/350/${linked.username}` },
        footer: { text: 'Pontos apurados uma vez por dia' },
      },
    ],
  });
}

// Segunda mensagem fixa do canal de status, separada do painel ao vivo da guilda.
export async function ensureLeaderboardPanel(client, guildDiscordId) {
  const cfg = await getConfig(guildDiscordId);
  const payload = await buildLeaderboardPanel();
  return ensurePanel(client, cfg.channels?.panel, STATE_ID, payload, 'leaderboards');
}

// A escolha responde só a quem clicou: a mensagem pública continua nos pontos.
export async function handleLeaderboardSelect(interaction) {
  const key = interaction.values?.[0];
  await interaction.deferReply({ ephemeral: true });

  if (key === 'pontos') {
    const doc = await pointsLeaderboard('alltime');
    return interaction.editReply({ embeds: [renderPoints(doc)] });
  }
  if (!CATEGORIES[key]) return interaction.editReply('Ranking desconhecido.');

  const doc = await categoryLeaderboard(key);
  return interaction.editReply({ embeds: [renderCategory(key, doc)] });
}
