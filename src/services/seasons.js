import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { currentWynnSeason } from './wynnSeason.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

export async function getActiveSeason() {
  return collections.seasons().findOne({ active: true });
}

function autoSeasonId() {
  const d = new Date();
  return `auto-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function seasonMode() {
  const gid = optional('DISCORD_GUILD_ID');
  if (!gid) return 'wynn';
  return (await getConfig(gid)).params?.seasonMode ?? 'wynn';
}

// Abre uma season nova, fechando a anterior. Idempotente: se a ativa já é a que
// queremos, não faz nada.
async function rotateTo({ seasonId, source, wynnSeason = null, offSeason = false }) {
  const current = await getActiveSeason();
  if (current?.seasonId === seasonId) return current;

  const now = new Date();
  if (current) {
    await collections.seasons().updateOne({ _id: current._id }, { $set: { active: false, endAt: now } });
    log.info(`Season ${current.seasonId} encerrada; abrindo ${seasonId}.`);
  }
  const doc = { seasonId, startAt: now, endAt: null, active: true, source, wynnSeason, offSeason };
  await collections.seasons().insertOne(doc);
  return doc;
}

// Garante que exista uma season ativa, para que nada seja pontuado sem bucket.
//
// No modo padrão ('wynn'), a season do bot segue a do jogo: durante a season 31
// tudo cai em `S31`; quando ela encerra, o bot abre `OFF-31` e a contagem de
// off-season começa ali. Assim os pontos ficam separados sem ninguém apertar
// botão nenhum. Em 'manual', volta o comportamento antigo (/season start).
export async function ensureActiveSeason() {
  const mode = await seasonMode();

  if (mode === 'wynn') {
    const wynnSeason = await currentWynnSeason();
    if (wynnSeason) {
      return rotateTo({
        seasonId: wynnSeason.id,
        source: 'wynn',
        wynnSeason: wynnSeason.number,
        offSeason: !wynnSeason.active,
      });
    }
    log.warn('Não detectei a season do Wynncraft; mantendo a season ativa atual.');
  }

  const s = await getActiveSeason();
  if (s) return s;
  return rotateTo({ seasonId: autoSeasonId(), source: 'auto' });
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
