import { collections } from '../db/mongo.js';
import { getActiveSeason } from './seasons.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Livro-razão de pontos.
//
// Nenhum evento guarda pontos — guarda a QUANTIDADE BRUTA do que aconteceu
// (2 guerras, 1 guild raid, 4.5M de XP contribuído, uma captura de x2.2). O
// valor em pontos é sempre derivado dos pesos ATUAIS na hora de somar. Trocar
// um peso em /config reescreve todo o histórico, porque nunca houve um número
// congelado para ficar defasado.
//
// guildStats.points e seasonParticipation.points são cache materializado:
// recomputáveis a qualquer momento a partir de pointsEvents.

export const EVENT_TYPES = ['war', 'raid', 'guildRaid', 'weekly', 'contribution', 'territory', 'manual'];

/**
 * Leaderboards de número cru, um por fonte de contribuição.
 * `alltime` aponta para o campo em guildStats; `season`, para o de
 * seasonParticipation.
 *
 * Só entram fontes que valem ponto. Raid comum (fora de guilda) não vale nada na
 * tabela oficial, então não tem ranking — o "leaderboard de raid" é o de GUILD
 * RAID, e ter os dois só confundiria.
 *
 * @typedef {object} Category
 * @property {string}  label
 * @property {string}  emoji
 * @property {string}  [menuEmoji] emoji de componente (botão/menu); a API só
 *                                 aceita Unicode ou <:nome:id> ali, nunca shortcode
 * @property {string}  btn      rótulo curto, para caber num botão do painel
 * @property {string}  unit     unidade exibida ao lado do número
 * @property {string}  alltime  campo em guildStats
 * @property {string}  season   campo em seasonParticipation
 * @property {boolean} [short]  abreviar números grandes (ex.: 50M)
 * @property {string[]} events  tipos de evento do livro-razão cujos pontos são
 *                              desta categoria (território é bônus de guerra)
 * @type {Readonly<Record<string, Category>>}
 */
export const CATEGORIES = Object.freeze({
  war: { label: 'Guerras', btn: 'Guerras', emoji: ':crossed_swords:', menuEmoji: '🗡️', unit: 'guerras', alltime: 'guildWars', season: 'warsFought', events: ['war', 'territory'] },
  guildraid: { label: 'Guild Raids', btn: 'Raids', emoji: '🛡️', unit: 'guild raids', alltime: 'guildRaids', season: 'guildRaidsDelta', events: ['guildRaid'] },
  xp: { label: 'XP contribuído', btn: 'XP', emoji: '📈', unit: 'XP', alltime: 'contributed', season: 'contributedDelta', short: true, events: ['contribution'] },
  weekly: { label: 'Objetivos semanais', btn: 'Semanais', emoji: '📅', unit: 'objetivos', alltime: 'weeklyObjectives', season: 'weeklyDelta', events: ['weekly'] },
});

/** Tipo de evento → chave de CATEGORIES. */
const CATEGORY_OF_EVENT = Object.freeze(
  Object.fromEntries(Object.entries(CATEGORIES).flatMap(([key, c]) => c.events.map((t) => [t, key]))),
);

/**
 * @param {object} ev
 * @param {string} [ev.seasonId]  balde da season; por padrão, a season ATIVA.
 *   Só quem lança evento com data antiga precisa passar isto — a season certa é
 *   a que estava aberta na hora do fato, e não a de hoje (ver
 *   scripts/backfill-territory.js).
 */
export async function recordEvent({ uuid, username, type, qty, meta = null, at = new Date(), seasonId }) {
  if (!qty) return null;
  const balde = seasonId === undefined ? (await getActiveSeason())?.seasonId ?? null : seasonId;
  try {
    await collections.pointsEvents().insertOne({
      uuid,
      username,
      type,
      qty,
      meta,
      seasonId: balde,
      at,
    });
  } catch (e) {
    // Índice único por (uuid, tipo, snapshotAt): reprocessar o mesmo snapshot
    // não pode pontuar duas vezes.
    if (e?.code === 11000) return false;
    throw e;
  }
  return true;
}

/**
 * Bônus de sequência do objetivo semanal: +10% por semana consecutiva, com teto.
 * @param {number} streak  semanas seguidas (1 = primeira)
 * @param {object} params
 * @returns {number} fator multiplicativo, ex.: 1.2 para streak 3
 */
function weeklyStreakFactor(streak, params) {
  const per = Number(params.weeklyStreakBonusPerWeek ?? 0.1);
  const max = Number(params.weeklyStreakBonusMax ?? 1);
  const weeks = Math.max(1, Number(streak) || 1);
  return 1 + Math.min(max, per * (weeks - 1));
}

/**
 * Único lugar que converte quantidade bruta em pontos.
 * @param {{type: string, qty: number, meta?: object}} event
 * @param {import('../config/guildConfig.js').GuildParams} params
 * @returns {number}
 */
export function eventPoints(event, params = {}) {
  const w = params.pointsWeights || {};
  switch (event.type) {
    case 'war':
      return event.qty * (w.war || 0);
    case 'raid':
      return event.qty * (w.raid || 0);
    case 'guildRaid':
      return event.qty * (w.guildRaid || 0);
    case 'weekly':
      return event.qty * (w.weekly || 0) * weeklyStreakFactor(event.meta?.streak, params);
    case 'contribution':
      return (event.qty / 1_000_000) * (w.contribPerMillion || 0);
    // Peso do território capturado, creditado a quem guerreou na janela (ver
    // attributeCaptures em services/territories.js e o bloco de atribuição no
    // topo de services/watcher.js).
    case 'territory': {
      // `qty` é o multiplicador CRU da captura (1 + 0.3×conexões, e os externals
      // no QG). A GUERRA já pagou a base, então aqui entra só o excedente:
      //
      //     guerra + território = war + territoryBase × (mult − 1)
      //                         = war × mult          (quando as bases são iguais)
      //
      // Sem isso, capturar um território pagaria a base duas vezes.
      const cap = Number(params.territoryMultiplierCap) || Infinity;
      const mult = Math.min(event.qty, cap);
      return Math.max(0, mult - 1) * (w.territoryBase || 0);
    }
    case 'manual':
      // Concessão da staff já está em pontos; não tem peso a aplicar.
      return event.qty;
    default:
      return 0;
  }
}

/**
 * A taxa do Guild XP em forma legível: "1 ponto a cada 2.000.000", e não
 * "0,5 ponto a cada 1.000.000". Abaixo de 1 ponto por milhão, inverte a conta
 * para o ponto ficar inteiro.
 * @param {number} contribPerMillion
 * @returns {{pts: number, xp: number}}
 */
export function xpRate(contribPerMillion) {
  const c = Number(contribPerMillion) || 0;
  if (c > 0 && c < 1) return { pts: 1, xp: Math.round(1_000_000 / c) };
  return { pts: c, xp: 1_000_000 };
}

/**
 * Pontos do Guild XP, sempre sobre o XP SOMADO e arredondados para BAIXO.
 *
 * Com 0,5 ponto por milhão, o `Math.round` do total dava 1 ponto a quem tinha
 * 1,2M (0,6 → 1) — meio caminho de um ponto virava ponto inteiro. E converter
 * evento a evento também não serve: a apuração é de hora em hora, cada delta
 * fica abaixo de 2M e o piso zeraria todo mundo. Soma primeiro, piso depois.
 *
 * O epsilon cobre o ponto flutuante: 10M × 0,3 dá 2,9999999999999996.
 * @param {number} qty  XP contribuído somado
 * @param {object} params
 * @returns {number}
 */
export function xpPoints(qty, params = {}) {
  return Math.floor(eventPoints({ type: 'contribution', qty }, params) + 1e-9);
}

/** Acumulador de uma pessoa: pontos das outras fontes + XP cru, convertido no fim. */
const somaVazia = () => ({ pts: 0, xp: 0 });
function somar(acc, ev, params) {
  if (ev.type === 'contribution') acc.xp += Number(ev.qty) || 0;
  else acc.pts += eventPoints(ev, params);
}
const totalDe = (acc, params) => Math.round(acc.pts) + xpPoints(acc.xp, params);

async function currentParams() {
  const gid = optional('DISCORD_GUILD_ID');
  if (!gid) return {};
  return (await getConfig(gid)).params || {};
}

// Recalcula o cache a partir do zero. Passe um uuid para recalcular só um membro.
export async function recomputePoints({ uuid = null } = {}) {
  const params = await currentParams();
  const filter = uuid ? { uuid } : {};

  const totals = new Map(); // uuid -> { username, points: {pts, xp}, weekly }
  const seasons = new Map(); // `${seasonId}|${uuid}` -> { seasonId, uuid, username, points: {pts, xp}, weekly }

  for await (const ev of collections.pointsEvents().find(filter)) {
    // Objetivos semanais são CONTADOS aqui, não incrementados na hora: o
    // contador vira derivada do livro-razão, como os pontos, e reprocessar
    // conserta sozinho qualquer divergência.
    const wk = ev.type === 'weekly' ? Number(ev.qty) || 0 : 0;

    const t = totals.get(ev.uuid) || { username: ev.username, points: somaVazia(), weekly: 0 };
    somar(t.points, ev, params);
    t.weekly += wk;
    if (ev.username) t.username = ev.username;
    totals.set(ev.uuid, t);

    // Baseline fica FORA da season, como já ficava fora da apuração de evento
    // (ver refreshScores em services/events.js). Ele é o passado inteiro do
    // membro na guilda, carregado no primeiro snapshot para o placar acumulado
    // não zerar um veterano — creditá-lo à season em que o membro apareceu
    // daria a ele um saldo que ele não fez nesta season.
    if (!ev.seasonId || ev.meta?.baseline) continue;
    const key = `${ev.seasonId}|${ev.uuid}`;
    const s = seasons.get(key) || {
      seasonId: ev.seasonId,
      uuid: ev.uuid,
      username: ev.username,
      points: somaVazia(),
      weekly: 0,
    };
    somar(s.points, ev, params);
    s.weekly += wk;
    if (ev.username) s.username = ev.username;
    seasons.set(key, s);
  }

  // Quem não tem mais nenhum evento precisa voltar a zero, senão sobra lixo do
  // cache anterior. Só faz sentido numa recomputação global.
  if (!uuid) {
    await collections.guildStats().updateMany({}, { $set: { points: 0, weeklyObjectives: 0 } });
    await collections.seasonParticipation().updateMany({}, { $set: { points: 0, weeklyDelta: 0 } });
  }

  for (const [id, t] of totals) {
    await collections.guildStats().updateOne(
      { uuid: id },
      {
        $set: {
          username: t.username,
          points: totalDe(t.points, params),
          weeklyObjectives: t.weekly,
          updatedAt: new Date(),
        },
        $setOnInsert: { firstSeenAt: new Date() },
      },
      { upsert: true },
    );
  }

  for (const s of seasons.values()) {
    await collections.seasonParticipation().updateOne(
      { seasonId: s.seasonId, uuid: s.uuid },
      {
        $set: {
          username: s.username,
          points: totalDe(s.points, params),
          weeklyDelta: s.weekly,
          lastUpdatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  log.info(
    `Pontos recomputados (${totals.size} membro(s), ${seasons.size} linha(s) de season)${uuid ? ' [parcial]' : ''}.`,
  );
  return { members: totals.size, seasonRows: seasons.size };
}

/**
 * Faz o livro-razão de guild raid alcançar a contagem exibida no ranking.
 *
 * A coluna 🛡️ é `guildStats.guildRaids`: o `currentGuildRaids` da API, a vida
 * inteira do membro NESTA guilda. Os pontos saem do livro-razão. Os dois se
 * separaram no `scripts/reset-stats.js`, que apaga os eventos de guild raid (a
 * linha de base junto) mas deixa o contador, de propósito. Resultado: quem já
 * tinha saído da guilda ficou com as raids na coluna e 0 pontos para sempre — sem
 * snapshot novo, nada volta a creditá-lo —, e quem ficou só pontuou o que fez
 * depois do reset.
 *
 * A diferença entra como linha de base (`meta.baseline`): conta no acumulado,
 * nunca na season nem em evento de competição, igual à do primeiro snapshot.
 *
 * Só completa, nunca desconta. Idempotente: com o livro-razão em dia, a diferença
 * é zero e nada é gravado. O snapshot grava o evento ANTES de subir o contador,
 * então rodar no meio de uma apuração vê no máximo diferença negativa, que é
 * ignorada.
 *
 * @returns {Promise<number>} membros completados — não zero = reapurar
 */
export async function reconcileGuildRaidLedger() {
  const lancado = new Map(
    (
      await collections
        .pointsEvents()
        .aggregate([{ $match: { type: 'guildRaid' } }, { $group: { _id: '$uuid', qty: { $sum: '$qty' } } }])
        .toArray()
    ).map((r) => [r._id, Number(r.qty) || 0]),
  );

  const at = new Date();
  const faltas = [];
  const cursor = collections
    .guildStats()
    .find({ guildRaids: { $gt: 0 } }, { projection: { uuid: 1, username: 1, guildRaids: 1 } });
  for await (const s of cursor) {
    const falta = Number(s.guildRaids) - (lancado.get(s.uuid) ?? 0);
    if (falta > 0) {
      faltas.push({
        uuid: s.uuid,
        username: s.username,
        type: 'guildRaid',
        qty: falta,
        meta: { baseline: true, reconciled: true },
        seasonId: null,
        at,
      });
    }
  }

  if (faltas.length) {
    await collections.pointsEvents().insertMany(faltas, { ordered: false });
    const raids = faltas.reduce((n, f) => n + f.qty, 0);
    log.info(`Livro-razão de guild raid completado: +${raids} raid(s) em ${faltas.length} membro(s).`);
  }
  return faltas.length;
}

/**
 * Objetivo semanal concluído, detectado AO VIVO pelo watcher.
 *
 * Não dá para contar isso no snapshot diário. A API só diz se o objetivo DESTA
 * semana está feito, então o snapshot precisa ver a virada de `false` para
 * `true` entre dois dias — e quem refaz o objetivo logo depois do reset semanal
 * aparece `true` em ambos. A virada nunca acontece na janela diária e a pessoa
 * nunca pontua, por ser rápida. O poller de 60s vê a virada de verdade.
 *
 * `meta.day` deixa a gravação idempotente: ninguém conclui dois objetivos
 * semanais no mesmo dia, então uma segunda inserção só pode ser oscilação da API.
 *
 * @param {{uuid: string, username: string, streak?: number, at?: Date}} completion
 * @returns {Promise<boolean>} false = já estava registrado
 */
export async function recordWeeklyCompletion({ uuid, username, streak = 0, at = new Date() }) {
  const inserted = await recordEvent({
    uuid,
    username,
    type: 'weekly',
    qty: 1,
    meta: { day: at.toISOString().slice(0, 10), streak },
    at,
  });
  if (!inserted) return false;
  // Materializa já: o contador e os pontos da pessoa não esperam a apuração
  // diária. O leaderboard, esse sim, só muda na virada do dia.
  await recomputePoints({ uuid });
  return true;
}

// Concessão manual da staff. Vira um evento como qualquer outro; o efeito é
// imediato para o membro afetado, mas o leaderboard só reflete na virada do dia.
export async function awardPoints(uuid, username, amount, reason = null) {
  await recordEvent({ uuid, username, type: 'manual', qty: amount, meta: { reason } });
  await recomputePoints({ uuid });
  return true;
}

export async function memberEvents(uuid, limit = 10) {
  return collections.pointsEvents().find({ uuid }).sort({ at: -1 }).limit(limit).toArray();
}

// ---- Leaderboard materializado (reconstruído 1x/dia) ----

// O cache guarda TODO MUNDO que já pontuou, sem corte.
//
// O corte antigo em 15 escondia quem parou de pontuar: ex-membro não perde o
// histórico (nada apaga guildStats), mas ia sendo ultrapassado por quem segue
// ativo até cair da lista — e aí parecia que sair da guilda zerava a
// contribuição. Contribuição é permanente, e o painel mostra isso: pagina de
// 20 em 20 (ver services/leaderboardPanel.js), quantas páginas forem precisas.
//
// Sem risco de estourar o documento: são ~50 bytes por linha, e o teto de um
// doc no Mongo é 16 MB — daria para uma guilda com mais de 300 mil membros.

function pointsId(seasonId) {
  return seasonId ? `season:${seasonId}` : 'alltime';
}

function categoryId(key, seasonId) {
  return seasonId ? `cat:${key}:season:${seasonId}` : `cat:${key}`;
}

/**
 * Quantos pontos cada categoria rendeu a cada pessoa, numa passada só pelo
 * livro-razão.
 *
 * Sai de `eventPoints`, e não de "número cru × peso": a semanal tem bônus de
 * sequência e a guerra teve bônus de território, então só o intérprete do
 * livro-razão dá o número que de fato entrou no total. Mesmas regras de escopo
 * do recomputePoints — baseline conta no acumulado, nunca na season.
 *
 * @returns {Promise<Map<string, Map<string, Record<string, number>>>>}
 *   escopo ('alltime' ou seasonId) → uuid → { chave da categoria: pontos }
 */
async function pointsBySource() {
  const params = await currentParams();
  const somas = new Map(); // escopo → uuid → categoria → {pts, xp}
  const add = (scope, uuid, key, ev) => {
    if (!somas.has(scope)) somas.set(scope, new Map());
    const porPessoa = somas.get(scope);
    const linha = porPessoa.get(uuid) || {};
    linha[key] ||= somaVazia();
    somar(linha[key], ev, params);
    porPessoa.set(uuid, linha);
  };

  const cursor = collections
    .pointsEvents()
    .find({ type: { $in: Object.keys(CATEGORY_OF_EVENT) } }, { projection: { uuid: 1, type: 1, qty: 1, meta: 1, seasonId: 1 } });
  for await (const ev of cursor) {
    const key = CATEGORY_OF_EVENT[ev.type];
    add('alltime', ev.uuid, key, ev);
    if (ev.seasonId && !ev.meta?.baseline) add(ev.seasonId, ev.uuid, key, ev);
  }

  // XP vira ponto só agora, sobre a soma — mesma conta do recomputePoints.
  const out = new Map();
  for (const [scope, porPessoa] of somas) {
    const m = new Map();
    for (const [uuid, linha] of porPessoa) {
      m.set(uuid, Object.fromEntries(Object.entries(linha).map(([k, acc]) => [k, totalDe(acc, params)])));
    }
    out.set(scope, m);
  }
  return out;
}

/**
 * Ordena por um campo cru e materializa { username, value, points, totalPoints }.
 *
 * `points` é o que ESTA atividade rendeu à pessoa; `totalPoints`, o total dela no
 * mesmo escopo — o painel mostra a fatia que a atividade representa.
 *
 * @param {string} key  chave de CATEGORIES
 * @param {Map<string, Record<string, number>>} [fonte]  pontos por uuid (pointsBySource)
 */
async function buildCategoryBoard(cache, _id, collection, field, extraFilter, builtAt, key, fonte) {
  const rows = await collection
    .find({ ...extraFilter, [field]: { $gt: 0 } })
    .sort({ [field]: -1 })
    .toArray();

  await cache.updateOne(
    { _id },
    {
      $set: {
        builtAt,
        rows: rows.map((r) => ({
          uuid: r.uuid,
          username: r.username,
          value: r[field] ?? 0,
          points: Math.round(fonte?.get(r.uuid)?.[key] ?? 0),
          totalPoints: r.points ?? 0,
        })),
      },
    },
    { upsert: true },
  );
}

export async function rebuildLeaderboards() {
  const cache = collections.leaderboardCache();
  const stats = collections.guildStats();
  const part = collections.seasonParticipation();
  const builtAt = new Date();

  const seasonIds = await part.distinct('seasonId');

  // Só os pontos: guerras e raids têm ranking próprio, e repeti-los aqui só
  // poluía a linha.
  const pointRow = (r) => ({ uuid: r.uuid, username: r.username, points: r.points ?? 0 });

  const alltime = await stats
    .find({ points: { $gt: 0 } })
    .sort({ points: -1 })
    .toArray();
  await cache.updateOne(
    { _id: pointsId(null) },
    { $set: { builtAt, rows: alltime.map(pointRow) } },
    { upsert: true },
  );

  for (const seasonId of seasonIds) {
    const rows = await part
      .find({ seasonId, points: { $gt: 0 } })
      .sort({ points: -1 })
      .toArray();
    await cache.updateOne(
      { _id: pointsId(seasonId) },
      { $set: { builtAt, rows: rows.map(pointRow) } },
      { upsert: true },
    );
  }

  // Números crus, uma tabela por categoria e escopo, cada linha com os pontos
  // que aquela atividade rendeu.
  const fontes = await pointsBySource();
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    await buildCategoryBoard(cache, categoryId(key, null), stats, cat.alltime, {}, builtAt, key, fontes.get('alltime'));
    for (const seasonId of seasonIds) {
      await buildCategoryBoard(cache, categoryId(key, seasonId), part, cat.season, { seasonId }, builtAt, key, fontes.get(seasonId));
    }
  }

  log.info(
    `Leaderboards reconstruídos (pontos + ${Object.keys(CATEGORIES).length} categorias × ${seasonIds.length + 1} escopo(s)).`,
  );
  return { seasons: seasonIds.length, categories: Object.keys(CATEGORIES).length, builtAt };
}

const EMPTY = { rows: [], builtAt: null };

export async function pointsLeaderboard(scope = 'alltime', seasonId = null) {
  const doc = await collections
    .leaderboardCache()
    .findOne({ _id: pointsId(scope === 'season' ? seasonId : null) });
  return doc ?? EMPTY;
}

export async function categoryLeaderboard(key, seasonId = null) {
  if (!CATEGORIES[key]) return EMPTY;
  const doc = await collections.leaderboardCache().findOne({ _id: categoryId(key, seasonId) });
  return doc ?? EMPTY;
}
