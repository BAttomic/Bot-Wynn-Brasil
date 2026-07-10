import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from './points.js';
import { shortNumber } from '../util/format.js';

export const SELECT_ID = 'lb:view';
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

export async function buildLeaderboardPanel() {
  const doc = await pointsLeaderboard('alltime');
  return { embeds: [renderPoints(doc)], components: [selectRow()] };
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
