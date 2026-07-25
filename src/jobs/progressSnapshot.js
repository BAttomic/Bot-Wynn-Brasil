import { takeSnapshots } from '../services/progress.js';
import { recomputePoints, rebuildLeaderboards } from '../services/points.js';

// Uma vez por dia: registra os deltas como eventos, recalcula os pontos a partir
// do histórico inteiro e materializa o leaderboard.
export async function runProgressSnapshot() {
  await takeSnapshots();
  await recomputePoints();
  await rebuildLeaderboards();
}
