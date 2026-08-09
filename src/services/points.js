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
 * @type {Readonly<Record<string, Category>>}
 */
export const CATEGORIES = Object.freeze({
  war: { label: 'Guerras', btn: 'Guerras', emoji: ':crossed_swords:', menuEmoji: '🗡️', unit: 'guerras', alltime: 'guildWars', season: 'warsFought' },
  guildraid: { label: 'Guild Raids', btn: 'Raids', emoji: '🛡️', unit: 'guild raids', alltime: 'guildRaids', season: 'guildRaidsDelta' },
  xp: { label: 'XP contribuído', btn: 'XP', emoji: '📈', unit: 'XP', alltime: 'contributed', season: 'contributedDelta', short: true },
  weekly: { label: 'Objetivos semanais', btn: 'Semanais', emoji: '📅', unit: 'objetivos', alltime: 'weeklyObjectives', season: 'weeklyDelta' },
});

export async function recordEvent({ uuid, username, type, qty, meta = null, at = new Date() }) {
  if (!qty) return null;
  const season = await getActiveSeason();
  try {
    await collections.pointsEvents().insertOne({
      uuid,
      username,
      type,
      qty,
      meta,
      seasonId: season?.seasonId ?? null,
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

async function currentParams() {
  const gid = optional('DISCORD_GUILD_ID');
  if (!gid) return {};
  return (await getConfig(gid)).params || {};
}

// Recalcula o cache a partir do zero. Passe um uuid para recalcular só um membro.
export async function recomputePoints({ uuid = null } = {}) {
  const params = await currentParams();
  const filter = uuid ? { uuid } : {};

  const totals = new Map(); // uuid -> { username, points, weekly }
  const seasons = new Map(); // `${seasonId}|${uuid}` -> { seasonId, uuid, username, points, weekly }

  for await (const ev of collections.pointsEvents().find(filter)) {
    const pts = eventPoints(ev, params);
    // Objetivos semanais são CONTADOS aqui, não incrementados na hora: o
    // contador vira derivada do livro-razão, como os pontos, e reprocessar
    // conserta sozinho qualquer divergência.
    const wk = ev.type === 'weekly' ? Number(ev.qty) || 0 : 0;

    const t = totals.get(ev.uuid) || { username: ev.username, points: 0, weekly: 0 };
    t.points += pts;
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
      points: 0,
      weekly: 0,
    };
    s.points += pts;
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
          points: Math.round(t.points),
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
          points: Math.round(s.points),
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

const CACHE_LIMIT = 15;

function pointsId(seasonId) {
  return seasonId ? `season:${seasonId}` : 'alltime';
}

function categoryId(key, seasonId) {
  return seasonId ? `cat:${key}:season:${seasonId}` : `cat:${key}`;
}

// Ordena por um campo cru e materializa { username, value }.
async function buildCategoryBoard(cache, _id, collection, field, extraFilter, builtAt) {
  const rows = await collection
    .find({ ...extraFilter, [field]: { $gt: 0 } })
    .sort({ [field]: -1 })
    .limit(CACHE_LIMIT)
    .toArray();

  await cache.updateOne(
    { _id },
    {
      $set: {
        builtAt,
        rows: rows.map((r) => ({ uuid: r.uuid, username: r.username, value: r[field] ?? 0 })),
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

  const pointRow = (r, warsField, raidsField) => ({
    uuid: r.uuid,
    username: r.username,
    points: r.points ?? 0,
    guildWars: r[warsField] ?? 0,
    guildRaids: r[raidsField] ?? 0,
  });

  const alltime = await stats
    .find({ points: { $gt: 0 } })
    .sort({ points: -1 })
    .limit(CACHE_LIMIT)
    .toArray();
  await cache.updateOne(
    { _id: pointsId(null) },
    { $set: { builtAt, rows: alltime.map((r) => pointRow(r, 'guildWars', 'guildRaids')) } },
    { upsert: true },
  );

  for (const seasonId of seasonIds) {
    const rows = await part
      .find({ seasonId, points: { $gt: 0 } })
      .sort({ points: -1 })
      .limit(CACHE_LIMIT)
      .toArray();
    await cache.updateOne(
      { _id: pointsId(seasonId) },
      { $set: { builtAt, rows: rows.map((r) => pointRow(r, 'warsFought', 'guildRaidsDelta')) } },
      { upsert: true },
    );
  }

  // Números crus, uma tabela por categoria e escopo.
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    await buildCategoryBoard(cache, categoryId(key, null), stats, cat.alltime, {}, builtAt);
    for (const seasonId of seasonIds) {
      await buildCategoryBoard(cache, categoryId(key, seasonId), part, cat.season, { seasonId }, builtAt);
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
