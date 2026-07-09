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

export const EVENT_TYPES = ['war', 'raid', 'guildRaid', 'contribution', 'territory', 'manual'];

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

// Único lugar que converte quantidade em pontos.
export function eventPoints(event, params = {}) {
  const w = params.pointsWeights || {};
  switch (event.type) {
    case 'war':
      return event.qty * (w.war || 0);
    case 'raid':
      return event.qty * (w.raid || 0);
    case 'guildRaid':
      return event.qty * (w.guildRaid || 0);
    case 'contribution':
      return (event.qty / 1_000_000) * (w.contribPerMillion || 0);
    case 'territory': {
      // qty é o multiplicador CRU da captura. O teto é aplicado aqui, então
      // mexer em territoryMultiplierCap também reescreve o histórico.
      const cap = Number(params.territoryMultiplierCap) || Infinity;
      return Math.min(event.qty, cap) * (w.territoryBase || 0);
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

  const totals = new Map(); // uuid -> { username, points }
  const seasons = new Map(); // `${seasonId}|${uuid}` -> { seasonId, uuid, username, points }

  for await (const ev of collections.pointsEvents().find(filter)) {
    const pts = eventPoints(ev, params);

    const t = totals.get(ev.uuid) || { username: ev.username, points: 0 };
    t.points += pts;
    if (ev.username) t.username = ev.username;
    totals.set(ev.uuid, t);

    if (!ev.seasonId) continue;
    const key = `${ev.seasonId}|${ev.uuid}`;
    const s = seasons.get(key) || {
      seasonId: ev.seasonId,
      uuid: ev.uuid,
      username: ev.username,
      points: 0,
    };
    s.points += pts;
    if (ev.username) s.username = ev.username;
    seasons.set(key, s);
  }

  // Quem não tem mais nenhum evento precisa voltar a zero, senão sobra lixo do
  // cache anterior. Só faz sentido numa recomputação global.
  if (!uuid) {
    await collections.guildStats().updateMany({}, { $set: { points: 0 } });
    await collections.seasonParticipation().updateMany({}, { $set: { points: 0 } });
  }

  for (const [id, t] of totals) {
    await collections.guildStats().updateOne(
      { uuid: id },
      {
        $set: { username: t.username, points: Math.round(t.points), updatedAt: new Date() },
        $setOnInsert: { firstSeenAt: new Date() },
      },
      { upsert: true },
    );
  }

  for (const s of seasons.values()) {
    await collections.seasonParticipation().updateOne(
      { seasonId: s.seasonId, uuid: s.uuid },
      { $set: { username: s.username, points: Math.round(s.points), lastUpdatedAt: new Date() } },
      { upsert: true },
    );
  }

  log.info(
    `Pontos recomputados (${totals.size} membro(s), ${seasons.size} linha(s) de season)${uuid ? ' [parcial]' : ''}.`,
  );
  return { members: totals.size, seasonRows: seasons.size };
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

function cacheId(seasonId) {
  return seasonId ? `season:${seasonId}` : 'alltime';
}

export async function rebuildLeaderboards() {
  const cache = collections.leaderboardCache();
  const builtAt = new Date();

  const alltime = await collections
    .guildStats()
    .find({ points: { $gt: 0 } })
    .sort({ points: -1 })
    .limit(CACHE_LIMIT)
    .toArray();

  await cache.updateOne(
    { _id: cacheId(null) },
    {
      $set: {
        builtAt,
        rows: alltime.map((r) => ({
          uuid: r.uuid,
          username: r.username,
          points: r.points ?? 0,
          guildWars: r.guildWars ?? 0,
          guildRaids: r.guildRaids ?? 0,
        })),
      },
    },
    { upsert: true },
  );

  const seasonIds = await collections.seasonParticipation().distinct('seasonId');
  for (const seasonId of seasonIds) {
    const rows = await collections
      .seasonParticipation()
      .find({ seasonId, points: { $gt: 0 } })
      .sort({ points: -1 })
      .limit(CACHE_LIMIT)
      .toArray();
    await cache.updateOne(
      { _id: cacheId(seasonId) },
      {
        $set: {
          builtAt,
          rows: rows.map((r) => ({
            uuid: r.uuid,
            username: r.username,
            points: r.points ?? 0,
            guildWars: r.warsFought ?? 0,
            guildRaids: r.guildRaidsDelta ?? 0,
          })),
        },
      },
      { upsert: true },
    );
  }

  log.info(`Leaderboards reconstruídos (acumulado + ${seasonIds.length} season(s)).`);
  return { seasons: seasonIds.length, builtAt };
}

export async function pointsLeaderboard(scope = 'alltime', seasonId = null) {
  const doc = await collections
    .leaderboardCache()
    .findOne({ _id: cacheId(scope === 'season' ? seasonId : null) });
  return doc ?? { rows: [], builtAt: null };
}
