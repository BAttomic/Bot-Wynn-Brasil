import { collections } from '../db/mongo.js';

export async function getActiveSeason() {
  return collections.seasons().findOne({ active: true });
}

function autoSeasonId() {
  const d = new Date();
  return `auto-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Garante que exista uma season ativa (cria uma automática se não houver),
// para que o rastreio de guerras nunca perca dados por falta de fronteira.
export async function ensureActiveSeason() {
  let s = await getActiveSeason();
  if (!s) {
    s = {
      seasonId: autoSeasonId(),
      startAt: new Date(),
      endAt: null,
      active: true,
      source: 'auto',
    };
    await collections.seasons().insertOne(s);
  }
  return s;
}

export async function startSeason(seasonId) {
  // Encerra a atual e abre a nova.
  await collections
    .seasons()
    .updateMany({ active: true }, { $set: { active: false, endAt: new Date() } });
  const s = {
    seasonId,
    startAt: new Date(),
    endAt: null,
    active: true,
    source: 'manual',
  };
  await collections.seasons().insertOne(s);
  return s;
}

export async function endActiveSeason() {
  const s = await getActiveSeason();
  if (!s) return null;
  await collections
    .seasons()
    .updateOne({ _id: s._id }, { $set: { active: false, endAt: new Date() } });
  return s;
}

export async function listSeasons(limit = 15) {
  return collections.seasons().find({}).sort({ startAt: -1 }).limit(limit).toArray();
}
