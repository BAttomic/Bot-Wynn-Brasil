// Reconstrói o livro-razão de pontos a partir dos snapshots já existentes.
//
// Antes, os pontos eram somados direto em guildStats.points. Agora eles são
// derivados de pointsEvents, e um recompute do zero apagaria o passado. Os
// snapshots guardam as métricas absolutas de cada dia, então a diferença entre
// dois snapshots consecutivos reconstrói exatamente os eventos que faltam.
//
//   node scripts/backfill-points.js --dry
//   node scripts/backfill-points.js
//
// É idempotente: o índice único (uuid, type, meta.snapshotAt) impede duplicar.
// Não reconstrói capturas de território nem concessões manuais — essas nunca
// existiram como snapshot.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';
import { recordEvent, recomputePoints, rebuildLeaderboards } from '../src/services/points.js';

const DRY = process.argv.includes('--dry');

function delta(current, previous, cap) {
  const d = Number(current ?? 0) - Number(previous ?? 0);
  if (d <= 0) return 0;
  if (cap && d > cap) return 0; // reset de conta / troca de uuid
  return d;
}

async function main() {
  loadEnv();
  await connectMongo();

  const uuids = await collections.progressSnapshots().distinct('uuid');
  console.log(`${uuids.length} membro(s) com histórico de snapshot.\n`);

  let created = 0;
  for (const uuid of uuids) {
    const snaps = await collections
      .progressSnapshots()
      .find({ uuid })
      .sort({ takenAt: 1 })
      .toArray();

    let emitted = 0;
    for (let i = 1; i < snaps.length; i += 1) {
      const prev = snaps[i - 1].metrics || {};
      const curr = snaps[i].metrics || {};
      const at = snaps[i].takenAt;
      const username = snaps[i].username;
      const meta = { snapshotAt: at, backfill: true };

      const events = [
        ['war', delta(curr.wars, prev.wars, 2000)],
        ['raid', delta(curr.raids, prev.raids, 2000)],
        ['guildRaid', delta(curr.guildRaids, prev.guildRaids, 500)],
        ['contribution', delta(curr.contributed, prev.contributed)],
      ];

      for (const [type, qty] of events) {
        if (!qty) continue;
        emitted += 1;
        if (!DRY) await recordEvent({ uuid, username, type, qty, meta, at });
      }
    }
    if (emitted) {
      created += emitted;
      console.log(`${DRY ? '[dry] ' : ''}${snaps[0].username}: ${emitted} evento(s) de ${snaps.length} snapshot(s)`);
    }
  }

  console.log(`\n${DRY ? '[dry] ' : ''}${created} evento(s) reconstruído(s).`);

  if (!DRY) {
    const { members } = await recomputePoints();
    await rebuildLeaderboards();
    console.log(`Pontos recomputados para ${members} membro(s) e ranking refeito.`);
  }

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
