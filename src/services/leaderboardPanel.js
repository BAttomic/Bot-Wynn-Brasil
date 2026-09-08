import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel, panelMessageId } from './panels.js';
import { pointsLeaderboard, categoryLeaderboard, CATEGORIES } from './points.js';
import { getActiveSeason } from './seasons.js';
import { allowanceDays, forgivenessDays, daysOffline } from './inactivity.js';
import { wynn } from '../wynn/api.js';
import { shortNumber } from '../util/format.js';
import { PECAS, anexo } from '../discord/commands/uniforme.js';
import { logoAttachment, brandWithLogo } from '../util/assets.js';

/** Select antigo do painel. Mantido só para não quebrar mensagens ainda não reeditadas. */
export const SELECT_ID = 'lb:view';
/** Botão por ranking: `lb:v:<view>`. */
export const VIEW_PREFIX = 'lb:v:';
/** Botão de escopo: `lb:s:alltime` | `lb:s:season`. */
export const SCOPE_PREFIX = 'lb:s:';
/** Botão de página: `lb:p:<índice base 0>`. */
export const PAGE_PREFIX = 'lb:p:';
/**
 * Linhas por página. O ranking inteiro é paginado — quantas páginas forem
 * precisas —, e a navegação é por setas justamente por isso: botão numerado
 * por página não caberia numa guilda grande.
 */
export const PAGE_SIZE = 20;
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

/**
 * Fatia a página pedida, devolvendo também o índice ABSOLUTO do primeiro item
 * — sem ele a página 2 recomeçaria a numeração no 1º lugar.
 */
function paginar(rows, page) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const inicio = p * PAGE_SIZE;
  return { fatia: rows.slice(inicio, inicio + PAGE_SIZE), inicio, page: p, pages };
}

function stamp(doc, seasonId, page = 0, pages = 1, total = 0) {
  const dePagina = pages > 1 ? ` · página ${page + 1}/${pages}` : '';
  return {
    footer: { text: `${seasonId ? `Season ${seasonId}` : 'Acumulado'} · apurado uma vez por dia · ${total} no ranking${dePagina}` },
    timestamp: doc.builtAt ? new Date(doc.builtAt).toISOString() : undefined,
  };
}

/**
 * @param {{rows?: object[], builtAt?: Date}} doc  documento do cache
 * @param {string|null} seasonId
 * @returns {import('discord.js').APIEmbed}
 */
export function renderPoints(doc, seasonId = null, page = 0) {
  const rows = doc?.rows ?? [];
  if (!rows.length) {
    return { title: '🏆 Pontos de contribuição', color: 0xf1c40f, description: 'Ainda não há pontos apurados.' };
  }
  const { fatia, inicio, page: p, pages } = paginar(rows, page);
  const lines = fatia.map(
    (r, i) => `${badge(inicio + i)} **${r.username}** — ${r.points} pts · :crossed_swords: ${r.guildWars} · 🛡️ ${r.guildRaids}`,
  );
  return { title: '🏆 Pontos de contribuição', color: 0xf1c40f, description: lines.join('\n'), ...stamp(doc, seasonId, p, pages, rows.length) };
}

/**
 * @param {string} key  chave de CATEGORIES
 * @param {{rows?: object[], builtAt?: Date}} doc
 * @param {string|null} seasonId
 * @returns {import('discord.js').APIEmbed}
 */
export function renderCategory(key, doc, seasonId = null, page = 0) {
  const cat = CATEGORIES[key];
  if (!cat) return { title: 'Ranking desconhecido', color: 0xe74c3c, description: 'Essa categoria não existe.' };

  const rows = doc?.rows ?? [];
  if (!rows.length) {
    return { title: `${cat.emoji} ${cat.label}`, color: 0x3498db, description: 'Ninguém pontuou aqui ainda.' };
  }
  const fmt = (v) => (cat.short ? shortNumber(v) : Number(v).toLocaleString('pt-BR'));
  const { fatia, inicio, page: p, pages } = paginar(rows, page);
  const lines = fatia.map((r, i) => `${badge(inicio + i)} **${r.username}** — \`${fmt(r.value)}\` ${cat.unit}`);
  return { title: `${cat.emoji} ${cat.label}`, color: 0x3498db, description: lines.join('\n'), ...stamp(doc, seasonId, p, pages, rows.length) };
}

/** Visão padrão do painel. @type {string} */
export const DEFAULT_VIEW = 'pontos';
/** Escopo padrão: o placar de sempre. @type {string} */
export const DEFAULT_SCOPE = 'alltime';

/** @param {string} v */
function validView(v) {
  return v === DEFAULT_VIEW || CATEGORIES[v] ? v : DEFAULT_VIEW;
}

/** @param {string} s */
function validScope(s) {
  return s === 'season' ? 'season' : DEFAULT_SCOPE;
}

/**
 * Ranking e escopo exibidos valem para TODO MUNDO, então precisam sobreviver ao
 * job que republica o painel a cada 5 minutos. Ficam no mesmo documento do
 * messageId.
 * @returns {Promise<{view: string, scope: string}>}
 */
async function currentState() {
  const doc = await collections.watcherState().findOne({ _id: STATE_ID });
  return {
    view: validView(doc?.view),
    scope: validScope(doc?.scope),
    page: Math.max(0, Number(doc?.page) || 0),
  };
}

/** @param {{view: string, scope: string, page?: number}} state */
function saveState({ view, scope, page = 0 }) {
  return collections
    .watcherState()
    .updateOne({ _id: STATE_ID }, { $set: { view, scope, page } }, { upsert: true });
}

/**
 * Uma linha com os cinco rankings. O ativo fica azul; os outros, cinza — assim
 * dá para ver o que está na tela sem abrir menu nenhum.
 * @param {string} view
 */
function viewRow(view) {
  const btn = (id, label, emoji) =>
    new ButtonBuilder()
      .setCustomId(`${VIEW_PREFIX}${id}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setStyle(id === view ? ButtonStyle.Primary : ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(
    btn(DEFAULT_VIEW, 'Pontos', '🏆'),
    // O Discord só aceita Unicode (ou <:nome:id>) no emoji de um botão.
    ...Object.entries(CATEGORIES).map(([id, c]) => btn(id, c.btn, c.menuEmoji || c.emoji)),
  );
}

/**
 * Navegação por setas, com o "Meus pontos" no meio: << < ⭐ > >>
 *
 * A linha aparece SEMPRE, mesmo com uma página só — as setas apenas ficam
 * desabilitadas. Mesma regra do botão de season: o lugar de cada coisa no
 * painel não muda de uma hora para a outra, e o "Meus pontos" não pode sumir
 * só porque o ranking encolheu para uma página.
 *
 * As pontas travam no começo e no fim em vez de dar a volta: clicar em
 * "anterior" na primeira página e cair na última confunde mais do que ajuda.
 *
 * @param {number} page   página atual, base 0
 * @param {number} pages  quantas existem
 */
function pageRow(page, pages) {
  const noComeco = page <= 0;
  const noFim = page >= pages - 1;
  // O alvo vai clampado: botão desabilitado ainda precisa de um customId válido.
  //
  // A TAG no fim do id existe só para ele ser único na mensagem. O Discord
  // recusa a mensagem inteira se dois componentes tiverem o mesmo custom_id, e
  // nas pontas dois botões miram a mesma página: na 2ª, "<<" e "<" vão os dois
  // para a 1ª. Quem lê o id ignora a tag.
  const seta = (tag, label, alvo, off) =>
    new ButtonBuilder()
      .setCustomId(`${PAGE_PREFIX}${Math.min(Math.max(0, alvo), Math.max(0, pages - 1))}:${tag}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(off);

  return new ActionRowBuilder().addComponents(
    seta('f', '<<', 0, noComeco),
    seta('p', '<', page - 1, noComeco),
    // No centro porque é o botão mais usado: na ponta da linha de escopo ele
    // competia com a troca de season e passava despercebido.
    new ButtonBuilder().setCustomId(ME_ID).setLabel('Meus pontos').setEmoji('⭐').setStyle(ButtonStyle.Success),
    seta('n', '>', page + 1, noFim),
    seta('l', '>>', pages - 1, noFim),
  );
}

/**
 * Só o escopo. Sem season ativa o botão aparece desativado, em vez de sumir: o
 * lugar dele no painel não muda de uma hora para a outra.
 *
 * O "Meus pontos" saiu daqui para o meio das setas (ver pageRow).
 * @param {string} scope
 * @param {{seasonId: string, offSeason?: boolean}|null} season
 */
function scopeRow(scope, season) {
  const scopeBtn = (id, label, emoji, disabled = false) =>
    new ButtonBuilder()
      .setCustomId(`${SCOPE_PREFIX}${id}`)
      .setLabel(label)
      .setEmoji(emoji)
      .setDisabled(disabled)
      .setStyle(id === scope ? ButtonStyle.Primary : ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(
    scopeBtn(DEFAULT_SCOPE, 'Acumulado', '📊'),
    scopeBtn('season', season ? season.seasonId : 'Season', '🗓️', !season),
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
  const description =
    peca === 'uniforme'
      ? 'Esta é uma **camada (overlay) transparente**, não uma skin pronta. ' +
        'Baixe a imagem abaixo (clique nela) e, num editor de skins (ex.: novaskin.me), ' +
        '**sobreponha-a à sua própria skin** para montar seu uniforme.'
      : 'Baixe a capa abaixo (clique na imagem) e aplique com o **Wynntils**:\n' +
        '1. No jogo, com o **Wynntils** instalado, rode `/wynntils token`.\n' +
        '2. Vai aparecer um **link no chat do jogo** — clique nele para abrir seu ' +
        'cadastro em [account.wynntils.com](https://account.wynntils.com/profile.php).\n' +
        '3. No seu perfil, clique em **Choose PNG** e envie o arquivo da capa.\n\n' +
        '-# Não há versão para o modo elytra — se alguém quiser fazer uma, fique à vontade.';
  return interaction.editReply({
    embeds: [
      {
        title: `🇧🇷 ${label}`,
        description,
        color: 0x2ecc71,
        image: { url: `attachment://${file}` },
      },
    ],
    files: [anexo(peca)],
  });
}

/**
 * Monta o painel na visão/escopo/página pedidos (ou nos últimos escolhidos).
 * @param {string} [view]
 * @param {string} [scope]  'alltime' | 'season'
 * @param {number} [page]   índice base 0
 */
export async function buildLeaderboardPanel(view, scope, page) {
  const saved =
    view === undefined || scope === undefined || page === undefined ? await currentState() : null;
  const v = validView(view ?? saved.view);
  const s = validScope(scope ?? saved.scope);
  const pedida = page ?? saved?.page ?? 0;

  // A season é lida sempre: o botão precisa mostrar o ID vigente mesmo quando o
  // escopo exibido é o acumulado.
  const season = await getActiveSeason();
  // Escopo de season sem season ativa cai no acumulado, em vez de mostrar vazio.
  const seasonId = s === 'season' && season ? season.seasonId : null;

  // O doc vem antes de renderizar: a linha de páginas precisa saber quantas
  // linhas existem, e reler o cache só para isso seria uma ida a mais ao Mongo.
  const doc =
    v === DEFAULT_VIEW
      ? await pointsLeaderboard(seasonId ? 'season' : 'alltime', seasonId)
      : await categoryLeaderboard(v, seasonId);
  const total = doc?.rows?.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Página salva pode não existir mais (o ranking encolheu entre um clique e
  // outro): cai na última em vez de mostrar embed vazio.
  const pg = Math.min(Math.max(0, Number(pedida) || 0), pages - 1);

  const embed = v === DEFAULT_VIEW ? renderPoints(doc, seasonId, pg) : renderCategory(v, doc, seasonId, pg);

  return brandWithLogo({
    embeds: [embed],
    components: [viewRow(v), scopeRow(s, season), pageRow(pg, pages)],
  });
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
    `:crossed_swords: Guerras \`${stats?.guildWars ?? 0}\` · 🛡️ Guild Raids \`${stats?.guildRaids ?? 0}\` · 📅 Semanais \`${stats?.weeklyObjectives ?? 0}\``,
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

/** Documento de estado da mensagem fixa de downloads. @type {string} */
const DOWNLOADS_STATE_ID = 'downloadsPanel';

/**
 * Mensagem fixa com tudo que dá para baixar: skin da seleção, capa da guilda e
 * o modpack — mais o atalho do grupo de WhatsApp. Os botões abrem uma resposta
 * privada (só quem clicou vê) com o arquivo ou o link.
 */
function downloadsPanelPayload() {
  return brandWithLogo({
    embeds: [
      {
        title: '📥 Downloads da Wynn Brasil',
        color: 0x2ecc71,
        description:
          'Tudo que você precisa para entrar no clima da guilda:\n\n' +
          '🎽 **Skin da Seleção** — camada transparente para sobrepor na sua skin.\n' +
          '🧣 **Capa da Guilda** — a capa oficial da Wynn Brasil.\n' +
          '📦 **Modpack** — os mods recomendados, sempre na versão mais recente ' +
          '(instale pelo `.mrpack` e o launcher atualiza sozinho).\n\n' +
          '-# Clique num botão abaixo — a resposta aparece só para você.',
      },
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(SKIN_ID)
          .setLabel('Skin da Seleção')
          .setEmoji('🎽')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(CAPE_ID)
          .setLabel('Capa da Guilda')
          .setEmoji('🧣')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(MODPACK_ID)
          .setLabel('Modpack')
          .setEmoji('📦')
          .setStyle(ButtonStyle.Success),
      ),
    ],
  });
}

/** Linha com o convite do grupo de WhatsApp — fica no painel de info (ao vivo). */
export function communityRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Grupo WhatsApp')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Link)
      .setURL(WHATSAPP_URL),
  );
}

/**
 * Mensagem fixa de downloads, ENTRE o painel de info (ao vivo) e o de
 * leaderboard. Como o Discord não reordena mensagens, a POSIÇÃO depende da ordem
 * de criação: só publicamos depois que o painel de info (`panel`) já existe, para
 * ela nascer ABAIXO dele. Edições no lugar seguem sempre.
 */
export async function ensureDownloadsPanel(client, guildDiscordId) {
  const already = await panelMessageId(DOWNLOADS_STATE_ID);
  if (!already && !(await panelMessageId('panel'))) return null; // espera o info nascer
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(client, cfg.channels?.panel, DOWNLOADS_STATE_ID, downloadsPanelPayload(), 'downloads', [logoAttachment()]);
}

const SCORING_STATE_ID = 'scoringPanel';

/**
 * A mensagem que abre o bloco de contribuição: o que rende ponto, e para que o
 * ponto serve.
 *
 * Todo número sai da config, nenhum é escrito à mão. Uma tabela decorada aqui
 * viraria mentira no dia em que a staff mexesse num peso — e mentira num painel
 * fixo é pior que ausência de informação, porque ninguém desconfia dela.
 *
 * @param {import('../config/guildConfig.js').GuildParams} params
 */
function scoringPanelPayload(params) {
  const w = params?.pointsWeights ?? {};
  const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
  const semanalMax = Math.round(Number(w.weekly ?? 0) * (1 + (Number(params?.weeklyStreakBonusMax) || 0)));
  const bonusSemana = Math.round((Number(params?.weeklyStreakBonusPerWeek) || 0) * 100);

  return brandWithLogo({
    embeds: [
      {
        title: '📖 Como ganhar pontos',
        color: 0xf1c40f,
        description:
          'Tudo que você faz pela guilda vira ponto, e o ranking abaixo é a soma disso.' +
          ' A contagem é automática: não precisa avisar ninguém.',
        fields: [
          {
            name: `${CATEGORIES.guildraid.emoji} ${CATEGORIES.guildraid.label} — ${n(w.guildRaid)} pts`,
            value:
              `> ${n(w.guildRaid)} pontos para **cada** membro nosso no grupo, no instante em que a raid fecha.` +
              `\n> Party de 2 ou mais ainda rende **${n(params?.aspectsPerGuildRaid)}** aspect por cabeça — sozinho não rende.`,
          },
          {
            name: `${CATEGORIES.war.emoji} ${CATEGORIES.war.label} — ${n(w.war)} pts`,
            value: `> ${n(w.war)} pontos por guerra, multiplicados pelo valor do território (teto de x${params?.territoryMultiplierCap}).`,
          },
          {
            name: `${CATEGORIES.xp.emoji} ${CATEGORIES.xp.label} — ${n(w.contribPerMillion)} pt`,
            value: `> ${n(w.contribPerMillion)} ponto a cada ${n(1e6)} de Guild XP doado ao cofre.`,
          },
          {
            name: `${CATEGORIES.weekly.emoji} ${CATEGORIES.weekly.label} — ${n(w.weekly)} pts`,
            value:
              `> ${n(w.weekly)} pontos por objetivo concluído, **+${bonusSemana}%** por semana seguida` +
              ` — até ${n(semanalMax)} pts numa sequência longa.`,
          },
          {
            name: '🎁 Para que servem',
            value:
              `> **Margem de inatividade:** ${n(params?.inactivityDays)} dias base, mais 1 dia a cada` +
              ` ${n(params?.inactivityForgivenessPerPoints)} pontos (teto de ${n(params?.inactivityForgivenessMaxDays)}).` +
              ` Quem contribui tem mais folga para sumir sem perder o slot.` +
              `\n> **Recompensas:** com ${n(params?.rewardMinGuildDays)} dias de guilda você entra na fila de Tomes` +
              ` e recebe os aspects que as suas guild raids geraram.`,
          },
        ],
      },
    ],
  });
}

// Primeira das duas mensagens do bloco de contribuição, logo acima do ranking.
// Espera a de downloads nascer, pela mesma razão que as outras: a ordem no canal
// é a ordem em que elas são publicadas.
export async function ensureScoringPanel(client, guildDiscordId) {
  const already = await panelMessageId(SCORING_STATE_ID);
  if (!already && !(await panelMessageId(DOWNLOADS_STATE_ID))) return null;
  const cfg = await getConfig(guildDiscordId);
  return ensurePanel(
    client,
    cfg.channels?.panel,
    SCORING_STATE_ID,
    scoringPanelPayload(cfg.params),
    'como pontuar',
    [logoAttachment()],
  );
}
// Fecha o bloco de contribuição, ABAIXO da mensagem de "como pontuar". Mesma
// lógica de ordem: só publica depois que a anterior já existe.
export async function ensureLeaderboardPanel(client, guildDiscordId) {
  const already = await panelMessageId(STATE_ID);
  if (!already && !(await panelMessageId(SCORING_STATE_ID))) return null; // espera o 'como pontuar' nascer
  const cfg = await getConfig(guildDiscordId);
  const payload = brandWithLogo(await buildLeaderboardPanel());
  return ensurePanel(client, cfg.channels?.panel, STATE_ID, payload, 'leaderboards', [logoAttachment()]);
}

/**
 * Troca o ranking ou o escopo do painel PÚBLICO — todo mundo passa a ver a mesma
 * coisa. A escolha é persistida, senão o job de 5 minutos a desfaria.
 *
 * Atende os botões novos (`lb:v:*`, `lb:s:*`) e também o select antigo, que pode
 * sobreviver alguns minutos numa mensagem ainda não reeditada após o deploy.
 * @param {import('discord.js').MessageComponentInteraction} interaction
 */
export async function handleLeaderboardControl(interaction) {
  const id = interaction.customId;

  // ACK PRIMEIRO, ANTES DE QUALQUER I/O. O Discord invalida o token da interação
  // em 3 segundos: com uma leitura no Mongo aqui na frente, um hipo de latência
  // do banco fazia o clique morrer sem erro nenhum — o botão simplesmente não
  // respondia, e nem "Interação falhou" aparecia. Ler o estado depois do ack não
  // tem prazo.
  if (
    !id.startsWith(VIEW_PREFIX) &&
    !id.startsWith(SCOPE_PREFIX) &&
    !id.startsWith(PAGE_PREFIX) &&
    id !== SELECT_ID
  ) {
    return interaction.reply({ content: 'Controle desconhecido.', ephemeral: true });
  }
  await interaction.deferUpdate();

  const state = await currentState();
  // Trocar de ranking ou de escopo volta para a primeira página: a página 4 de
  // um ranking não quer dizer nada no outro, e costuma nem existir.
  // `lb:p:<página>:<tag>` — a tag só serve para o id ser único (ver pageRow).
  if (id.startsWith(PAGE_PREFIX)) state.page = Number(id.slice(PAGE_PREFIX.length).split(':')[0]) || 0;
  else if (id.startsWith(VIEW_PREFIX)) {
    state.view = id.slice(VIEW_PREFIX.length);
    state.page = 0;
  } else if (id.startsWith(SCOPE_PREFIX)) {
    state.scope = id.slice(SCOPE_PREFIX.length);
    state.page = 0;
  } else {
    state.view = interaction.values?.[0];
    state.page = 0;
  }

  // Ranking desconhecido cai no padrão em vez de virar erro: o clique já foi
  // aceito, e um followUp de reclamação só polui a tela de quem clicou.
  const next = {
    view: validView(state.view),
    scope: validScope(state.scope),
    page: Math.max(0, Number(state.page) || 0),
  };
  await saveState(next);
  await interaction.editReply(await buildLeaderboardPanel(next.view, next.scope, next.page));
}
