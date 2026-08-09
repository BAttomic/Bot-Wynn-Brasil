// Reconstrói guildWars / raidsInGuild a partir dos progressSnapshots.
//
//   node scripts/rebuild-from-snapshots.js                 # só compara
//   node scripts/rebuild-from-snapshots.js --write         # grava
//   node scripts/rebuild-from-snapshots.js --max-gap=72    # janela de confiança
//
// POR QUE ISTO É POSSÍVEL. Os contadores `guildWars` e `raidsInGuild` foram
// inflados por apurações concorrentes aplicando o MESMO delta duas vezes no
// `$inc`. Os snapshots, não: cada um é um retrato do que a API disse naquele
// instante, e um retrato repetido continua sendo o mesmo retrato. Somar os
// deltas entre snapshots CONSECUTIVOS, uma vez só, devolve o número verdadeiro.
//
// O QUE ISTO NÃO CONSEGUE, e não adianta fingir que consegue:
//
//   • Nada antes do primeiro snapshot do membro. A API do Wynncraft não expõe
//     histórico de contador — só o valor de agora. O que aconteceu antes de o
//     bot começar a olhar é irrecuperável, por qualquer meio.
//   • Separar guerra feita pela WnBR de guerra feita por outra guilda.
//     `globalData.wars` é da CONTA, não da guilda; a API não tem contador por
//     guilda. Se o membro guerreou por outro lado durante o período, entra.
//   • Intervalos com buraco. Se o membro saiu e voltou, ou o bot ficou fora do
//     ar, não há snapshot no meio e não dá para saber o que foi feito na nossa
//     guilda naquele vão. Intervalos maiores que --max-gap são DESCARTADOS e
//     reportados, em vez de creditados no escuro.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';

const WRITE = process.argv.includes('--write');
const gapArg = process.argv.find((a) => a.startsWith('--max-gap='));
const MAX_GAP_H = gapArg ? Number(gapArg.split('=')[1]) : 72;
const MAX_GAP_MS = MAX_GAP_H * 3_600_000;

// Mesmos tetos por intervalo do snapshot ao vivo (ver services/progress.js).
const CAP = { wars: 2000, raids: 2000 };

const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');

/**
 * Soma os deltas positivos entre snapshots consecutivos de um membro.
 * @param {Array<{takenAt: Date, metrics: object}>} snaps  em ordem cronológica
 * @param {string} campo
 * @param {number} cap
 * @returns {{total: number, pulados: number, buracos: number}}
 */
function acumular(snaps, campo, cap) {
  let total = 0;
  let pulados = 0;
  let buracos = 0;

  for (let i = 1; i < snaps.length; i += 1) {
    const antes = Number(snaps[i - 1].metrics?.[campo]);
    const agora = Number(snaps[i].metrics?.[campo]);
    // Um dos lados sem o campo: intervalo mudo, não um delta de tamanho do
    // valor absoluto. É exatamente o furo que inflou o guild raid da season.
    if (!Number.isFinite(antes) || !Number.isFinite(agora)) continue;

    const d = agora - antes;
    if (d <= 0) continue; // contador reiniciou (troca de conta) ou ficou parado

    const vao = new Date(snaps[i].takenAt) - new Date(snaps[i - 1].takenAt);
    if (vao > MAX_GAP_MS) {
      buracos += 1;
      pulados += d;
      continue;
    }
    if (d > cap) {
      pulados += d;
      continue;
    }
    total += d;
  }
  return { total, pulados, buracos };
}

async function main() {
  loadEnv();
  await connectMongo();

  const uuids = await collections.progressSnapshots().distinct('uuid');
  console.log(
    `${uuids.length} membro(s) com snapshot. Intervalos maiores que ${MAX_GAP_H}h são descartados.\n`,
  );

  const linhas = [];
  let totalPulado = 0;

  for (const uuid of uuids) {
    const snaps = await collections
      .progressSnapshots()
      .find({ uuid }, { projection: { takenAt: 1, metrics: 1, username: 1 } })
      .sort({ takenAt: 1 })
      .toArray();
    if (snaps.length < 2) continue;

    const guerra = acumular(snaps, 'wars', CAP.wars);
    const raid = acumular(snaps, 'raids', CAP.raids);
    const atual = await collections.guildStats().findOne({ uuid });
    if (!atual) continue;

    totalPulado += guerra.pulados;
    linhas.push({
      uuid,
      username: atual.username ?? snaps.at(-1).username,
      guerraHoje: atual.guildWars ?? 0,
      guerraReal: guerra.total,
      raidHoje: atual.raidsInGuild ?? 0,
      raidReal: raid.total,
      snaps: snaps.length,
      desde: snaps[0].takenAt,
      buracos: guerra.buracos,
    });
  }

  linhas.sort((a, b) => b.guerraHoje - a.guerraHoje);

  console.log('membro            | ⚔️ hoje | ⚔️ real | raid hoje | raid real | snaps | desde       | vãos');
  for (const l of linhas) {
    const inflado = l.guerraHoje > l.guerraReal ? ` (${(l.guerraHoje / (l.guerraReal || 1)).toFixed(1)}x)` : '';
    console.log(
      `${l.username.padEnd(17)} | ${String(l.guerraHoje).padStart(7)} | ${String(l.guerraReal).padStart(7)}${inflado.padEnd(8)}` +
        ` | ${String(l.raidHoje).padStart(9)} | ${String(l.raidReal).padStart(9)}` +
        ` | ${String(l.snaps).padStart(5)} | ${new Date(l.desde).toISOString().slice(0, 10)} | ${l.buracos}`,
    );
  }

  if (totalPulado) {
    console.log(
      `\n${n(totalPulado)} guerra(s) descartada(s) por caírem em vão maior que ${MAX_GAP_H}h ou acima do teto.` +
        '\nEsse pedaço é o que o bot não estava olhando — não dá para saber se foi feito pela WnBR.',
    );
  }

  if (!WRITE) {
    console.log('\nNada foi alterado. Rode com --write para gravar os valores da coluna "real".');
    await closeMongo();
    return;
  }

  for (const l of linhas) {
    await collections
      .guildStats()
      .updateOne({ uuid: l.uuid }, { $set: { guildWars: l.guerraReal, raidsInGuild: l.raidReal } });
  }
  console.log(`\n${linhas.length} membro(s) reescrito(s) a partir dos snapshots.`);
  console.log(
    'ATENÇÃO: isto conserta os CONTADORES, não o livro-razão. Os pontos continuam\n' +
      'somando os eventos duplicados de pointsEvents — para os pontos, o caminho é o\n' +
      'reset-stats.js. Rode /leaderboard atualizar depois.',
  );

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
