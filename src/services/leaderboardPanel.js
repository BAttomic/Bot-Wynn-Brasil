import { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel, panelMessageId } from './panels.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from './points.js';
import { allowanceDays, forgivenessDays, daysOffline } from './inactivity.js';
import { wynn } from '../wynn/api.js';
import { shortNumber } from '../util/format.js';
import { PECAS, anexo } from '../discord/commands/uniforme.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';

export const SELECT_ID = 'lb:view';
export const ME_ID = 'lb:me';
/** Botões de download das peças oficiais, no painel de status. */
export const SKIN_ID = 'lb:skin';
export const CAPE_ID = 'lb:cape';
/** Botão de download do modpack (abre a mensagem com link + Fabric). */
export const MODPACK_ID = 'lb:modpack';
/** Convite do grupo de WhatsApp da comunidade (botão-link). */
const WHATSAPP_URL = 'https://chat.whatsapp.com/DFwzI8rjMI02Akt5yLqTPj';
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

/** Visão padrão do painel. @type {string} */
export const DEFAULT_VIEW = 'pontos';

/**
 * A visão escolhida vale para TODO MUNDO, então precisa sobreviver ao job que
 * republica o painel a cada 5 minutos. Fica no mesmo documento do messageId.
 * @returns {Promise<string>}
 */
async function currentView() {
  const doc = await collections.watcherState().findOne({ _id: STATE_ID });
  const view = doc?.view;
  return view === DEFAULT_VIEW || CATEGORIES[view] ? view : DEFAULT_VIEW;
}

/** @param {string} view */
function saveView(view) {
  return collections.watcherState().updateOne({ _id: STATE_ID }, { $set: { view } }, { upsert: true });
}

/** @param {string} view marca a opção atual como selecionada */
function selectRow(view = DEFAULT_VIEW) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(SELECT_ID)
    .setPlaceholder('Trocar o ranking exibido…')
    .addOptions(
      {
        label: 'Pontos de contribuição',
        value: DEFAULT_VIEW,
        emoji: '🏆',
        description: 'O ranking geral (padrão)',
        default: view === DEFAULT_VIEW,
      },
      ...Object.entries(CATEGORIES).map(([value, c]) => ({
        label: c.label,
        value,
        emoji: c.emoji,
        description: `Números crus de ${c.unit}`,
        default: view === value,
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

/**
 * Segunda linha de botões do painel: baixar a skin da seleção (para sobrepor na
 * sua própria skin) e a capa da guilda, mais o link do grupo de WhatsApp.
 * O modpack fica em painel próprio (ver ensureModpackPanel).
 */
export function downloadsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SKIN_ID)
      .setLabel('Baixar Skin da Seleção')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(CAPE_ID)
      .setLabel('Baixar Capa da Guilda')
      .setEmoji('📥')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('Grupo WhatsApp')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Link)
      .setURL(WHATSAPP_URL),
  );
}

/**
 * Responde só a quem clicou, com o PNG anexado (baixável). A skin da seleção é
 * uma skin transparente feita para ser sobreposta à sua no editor de skins.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {'uniforme' | 'capa'} peca
 */
export async function handleAssetDownload(interaction, peca) {
  await interaction.deferReply({ ephemeral: true });
  const { file, label } = PECAS[peca];
  const dica =
    peca === 'uniforme'
      ? 'Baixe e **sobreponha na sua própria skin** num editor de skins (ex.: novaskin.me).'
      : 'Capa oficial da guilda. Baixe e aplique no seu perfil.';
  return interaction.editReply({
    embeds: [
      {
        title: `🇧🇷 ${label}`,
        description: `${dica}\n\nÉ só clicar na imagem para baixar.`,
        color: 0x2ecc71,
        image: { url: `attachment://${file}` },
      },
    ],
    files: [anexo(peca)],
  });
}

/**
 * Monta o painel na visão pedida (ou na última escolhida).
 * @param {string} [view]
 */
export async function buildLeaderboardPanel(view) {
  const v = view ?? (await currentView());
  const embed =
    v === DEFAULT_VIEW
      ? renderPoints(await pointsLeaderboard('alltime'))
      : renderCategory(v, await categoryLeaderboard(v));
  return brandWithLogo({ embeds: [embed], components: [selectRow(v), meRow()] });
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

/** Documento de estado da mensagem fixa do modpack. @type {string} */
const MODPACK_STATE_ID = 'modpackPanel';

/** Mensagem fixa dedicada ao modpack: um botão que abre o link + Fabric. */
function modpackPanelPayload() {
  return brandWithLogo({
    embeds: [
      {
        title: '📦 Modpack oficial — Wynn Brasil',
        color: 0x2ecc71,
        description:
          'Baixe o modpack recomendado da guilda. O botão abaixo entrega o link do ' +
          '`mods.rar` e o do **Fabric Installer**, com as instruções de instalação.',
      },
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(MODPACK_ID)
          .setLabel('Baixar Modpack')
          .setEmoji('📦')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

/**
 * Mensagem fixa do modpack, entre o painel de info (ao vivo) e o de leaderboard.
 * Como o Discord não reordena mensagens, a POSIÇÃO depende da ordem de criação:
 * só publicamos o modpack depois que o painel de info (`panel`) já existe, para
 * ele nascer ABAIXO dele. Edições no lugar seguem sempre.
 */
export async function ensureModpackPanel(client, guildDiscordId) {
  const already = await panelMessageId(MODPACK_STATE_ID);
  if (!already && !(await panelMessageId('panel'))) return null; // espera o info nascer
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(client, cfg.channels?.panel, MODPACK_STATE_ID, modpackPanelPayload(), 'modpack', [logoAttachment()]);
}

// Terceira mensagem fixa do canal de status, ABAIXO do modpack. Mesma lógica de
// ordem: só publica depois que o modpack já existe.
export async function ensureLeaderboardPanel(client, guildDiscordId) {
  const already = await panelMessageId(STATE_ID);
  if (!already && !(await panelMessageId(MODPACK_STATE_ID))) return null; // espera o modpack nascer
  const cfg = await getConfig(guildDiscordId);
  const payload = brandWithLogo(await buildLeaderboardPanel());
  return ensurePanel(client, cfg.channels?.panel, STATE_ID, payload, 'leaderboards', [logoAttachment()]);
}

/**
 * Troca o ranking exibido no painel PÚBLICO — todo mundo passa a ver a mesma
 * coisa. A escolha é persistida, senão o job de 5 minutos a desfaria.
 * @param {import('discord.js').StringSelectMenuInteraction} interaction
 */
export async function handleLeaderboardSelect(interaction) {
  const view = interaction.values?.[0];
  if (view !== DEFAULT_VIEW && !CATEGORIES[view]) {
    return interaction.reply({ content: 'Ranking desconhecido.', ephemeral: true });
  }

  await interaction.deferUpdate();
  await saveView(view);
  await interaction.editReply(await buildLeaderboardPanel(view));
}
