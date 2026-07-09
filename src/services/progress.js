import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from './guildData.js';
import { ensureActiveSeason } from './seasons.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Ignora deltas negativos (reset/troca de UUID) ou absurdamente grandes.
function safeDelta(current, previous, cap) {
  const d = current - previous;
  if (d <= 0) return 0;
  if (cap && d > cap) return 0;
  return d;
}

// Tira um snapshot diário de progresso de TODOS os membros da guilda e
// acumula os deltas de guerras/raids/contribuição (all-time e por season).
export async function takeSnapshots() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return;

  const res = await fetchGuildMembers(prefix);
  if (!res) return;

  const season = await ensureActiveSeason();
  const gid = optional('DISCORD_GUILD_ID');
  const cfg = gid ? await getConfig(gid) : null;
  const pw = cfg?.params?.pointsWeights || { war: 10, raid: 5, contribPerMillion: 1 };
  const now = new Date();
  const snaps = collections.progressSnapshots();
  const stats = collections.guildStats();
  const part = collections.seasonParticipation();

  let counted = 0;
  for (const m of res.members) {
    const metrics = { wars: m.wars, raids: m.raids, contributed: m.contributed };

    const last = await snaps
      .find({ uuid: m.uuid })
      .sort({ takenAt: -1 })
      .limit(1)
      .next();

    await snaps.insertOne({
      uuid: m.uuid,
      username: m.username,
      takenAt: now,
      inGuild: true,
      metrics,
    });

    let dWars = 0;
    let dRaids = 0;
    let dContrib = 0;
    if (last?.metrics) {
      dWars = safeDelta(metrics.wars, last.metrics.wars, 2000);
      dRaids = safeDelta(metrics.raids, last.metrics.raids, 2000);
      dContrib = Math.max(0, metrics.contributed - (last.metrics.contributed ?? 0));
    }

    // Pontos automáticos (design.md §17): guerras + raids + contribuição.
    const dPoints = Math.round(
      dWars * (pw.war || 0) + dRaids * (pw.raid || 0) + (dContrib / 1_000_000) * (pw.contribPerMillion || 0),
    );

    await stats.updateOne(
      { uuid: m.uuid },
      {
        $set: {
          username: m.username,
          lastWars: metrics.wars,
          lastRaids: metrics.raids,
          contributed: metrics.contributed,
          updatedAt: now,
        },
        $inc: { guildWars: dWars, guildRaids: dRaids, points: dPoints },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    );

    if (season && (dWars > 0 || dRaids > 0 || dContrib > 0 || dPoints > 0)) {
      await part.updateOne(
        { seasonId: season.seasonId, uuid: m.uuid },
        {
          $set: { username: m.username, lastUpdatedAt: now },
          $inc: { warsFought: dWars, raidsDelta: dRaids, contributedDelta: dContrib, points: dPoints },
        },
        { upsert: true },
      );
      if (dWars > 0) counted += dWars;
    }
  }
  log.info(`Snapshot concluído (${res.members.length} membros, +${counted} guerras na season ${season?.seasonId}).`);
}
