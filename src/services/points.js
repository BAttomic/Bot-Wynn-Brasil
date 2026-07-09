import { collections } from '../db/mongo.js';
import { getActiveSeason } from './seasons.js';

// Concede (ou remove, com valor negativo) pontos a um membro — usado tanto pelo
// cálculo automático (snapshot) quanto por eventos manuais da staff.
export async function awardPoints(uuid, username, amount, reason = null) {
  const now = new Date();
  await collections.guildStats().updateOne(
    { uuid },
    {
      $set: { username, updatedAt: now },
      $inc: { points: amount },
      $setOnInsert: { firstSeenAt: now },
    },
    { upsert: true },
  );
  const season = await getActiveSeason();
  if (season) {
    await collections.seasonParticipation().updateOne(
      { seasonId: season.seasonId, uuid },
      { $set: { username, lastUpdatedAt: now }, $inc: { points: amount } },
      { upsert: true },
    );
  }
  if (reason) {
    await collections.guildStats().updateOne(
      { uuid },
      { $push: { pointsLog: { amount, reason, at: now } } },
    );
  }
  return true;
}

export async function pointsLeaderboard(scope = 'alltime', seasonId = null, limit = 15) {
  if (scope === 'season') {
    return collections
      .seasonParticipation()
      .find({ seasonId, points: { $gt: 0 } })
      .sort({ points: -1 })
      .limit(limit)
      .toArray();
  }
  return collections
    .guildStats()
    .find({ points: { $gt: 0 } })
    .sort({ points: -1 })
    .limit(limit)
    .toArray();
}
