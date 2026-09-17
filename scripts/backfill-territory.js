// Credita o PESO das capturas já registradas a quem guerreou na janela delas.
//
//   node scripts/backfill-territory.js --dry    # mostra o que faria
//   node scripts/backfill-territory.js          # grava e reapura
//
// A conta inteira vive em src/services/territoryBackfill.js, que o BOOT também
// chama — um deploy já repõe o peso do passado sozinho. Este script existe para
// ver o relatório antes (ou depois), pessoa por pessoa, sem depender de log.
//
// Idempotente: o índice único (uuid, type, meta.captureId) recusa o segundo
// crédito da mesma captura, então rodar duas vezes não paga duas vezes.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo } from '../src/db/mongo.js';
import { backfillTerritoryCredits } from '../src/services/territoryBackfill.js';
import { rebuildLeaderboards } from '../src/services/points.js';

const DRY = process.argv.includes('--dry');

async function main() {
  loadEnv();
  await connectMongo();

  const r = await backfillTerritoryCredits({ dry: DRY });

  if (r.semDados) {
    console.log(`${r.semDados} captura(s) anterior(es) a qualquer registro de guerra: sem como saber quem guerreou.`);
  }
  if (!r.pendentes) {
    console.log('Nada a creditar — todas as capturas com peso já estão no livro-razão.');
    await closeMongo();
    return;
  }

  console.log(`${r.pendentes} captura(s) a creditar, ${r.creditos} crédito(s) para ${r.pessoas} pessoa(s).`);
  if (r.semGuerreiro) {
    console.log(`${r.semGuerreiro} sem nenhum incremento de contador na janela — ninguém a creditar.`);
  }
  for (const linha of r.porPessoa.slice(0, 20)) {
    console.log(`  ${linha.username}: ${linha.capturas} captura(s), +${Math.round(linha.pontos)} pts`);
  }

  if (DRY) {
    console.log('\n[dry] nada foi gravado.');
    await closeMongo();
    return;
  }

  console.log(`\n${r.gravados} crédito(s) gravado(s), pontos reapurados.`);
  await rebuildLeaderboards();
  console.log('Leaderboards reconstruídos. O painel se reedita em até 5 min, ou rode /leaderboard atualizar.');

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
