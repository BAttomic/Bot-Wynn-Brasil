import { takeSnapshots } from '../services/progress.js';
import { recomputePoints, rebuildLeaderboards } from '../services/points.js';
import { runEventTick } from './eventTick.js';

// Uma vez por dia: registra os deltas como eventos, recalcula os pontos a partir
// do histórico inteiro e materializa o leaderboard.
//
// Os eventos de competição entram no fim porque leem o MESMO livro-razão: sem
// isso, o painel de um evento só mostraria os números novos na hora seguinte.
// `client` é opcional — sem ele, o tick roda no próximo ciclo do scheduler.
export async function runProgressSnapshot(client = null) {
  await takeSnapshots();
  await recomputePoints();
  await rebuildLeaderboards();
  if (client) await runEventTick(client);
}
