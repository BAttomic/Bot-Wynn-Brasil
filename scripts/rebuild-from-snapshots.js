// Reconstrói guildWars / raidsInGuild a partir dos progressSnapshots.
//
//   node scripts/rebuild-from-snapshots.js                 # só compara
//   node scripts/rebuild-from-snapshots.js --write         # grava
//   node scripts/rebuild-from-snapshots.js --max-gap=72    # janela de confiança
//
// POR QUE ISTO É POSSÍVEL. Os contadores `guildWars` e `raidsInGuild` foram
// inflados porque o snapshot somava os deltas POSITIVOS de um contador que
// oscila: a API às vezes devolve o campo zerado ou parcial, e cada recuperação
// depois da queda era contada como progresso novo.
//
// Os snapshots guardam o VALOR ABSOLUTO de cada instante, não o delta. Então o
// dado bom continua lá: basta reler as duas pontas em vez de somar o caminho.
// É isso que este script faz (ver `acumular` abaixo).
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
//     guilda naquele vão. Como a conta é `último − primeiro`, o vão entra no
//     total de qualquer jeito; --max-gap só serve para SINALIZAR quantos houve,
//     para você saber o quanto do número depende de período não observado.

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
 * Acumulado de um contador de VIDA ao longo dos snapshots.
 *
 * NÃO é a soma dos deltas positivos, e essa distinção é o ponto todo.
 * `globalData.wars` e `globalData.raids` só podem subir — são contadores de
 * vida da conta. Quando a série gravada desce, o valor não veio do jogador,
 * veio da API (resposta parcial, nó de cache diferente, campo lido como 0).
 *
 * Somar os deltas positivos descarta as descidas e mantém as subidas, então
 * cada oscilação vira ganho permanente: um contador que pisca 122 → 0 → 122
 * quatro vezes acumula 488. Foi exatamente isso que aconteceu — o HunterAlas
 * ficou com 488 guerras tendo 122 na vida inteira, 4,0x cravado.
 *
 * `último − primeiro` atravessa o ruído inteiro sem se importar com ele: só
 * olha as duas pontas. Se o contador oscilou no meio, tanto faz. As duas contas
 * voltam a ser a MESMA coisa numa série saudável, e é por isso que a diferença
 * entre elas serve de medida direta do ruído.
 *
 * @param {Array<{takenAt: Date, metrics: object}>} snaps  em ordem cronológica
 * @param {string} campo
 * @param {number} cap  teto por intervalo, só para relatar salto absurdo
 */
function acumular(snaps, campo, cap) {
  const pts = snaps
    .map((s) => ({ at: s.takenAt, v: Number(s.metrics?.[campo]) }))
    .filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return { total: 0, ruido: 0, quedas: 0, buracos: 0 };

  let somaUps = 0;
  let quedas = 0;
  let buracos = 0;

  for (let i = 1; i < pts.length; i += 1) {
    const d = pts[i].v - pts[i - 1].v;
    if (d < 0) quedas += 1;
    if (d > 0 && d <= cap) somaUps += d;
    if (new Date(pts[i].at) - new Date(pts[i - 1].at) > MAX_GAP_MS) buracos += 1;
  }

  // As pontas. Negativo só se a conta trocou de dono; aí não há o que afirmar.
  const total = Math.max(0, pts.at(-1).v - pts[0].v);
  return { total, ruido: Math.max(0, somaUps - total), quedas, buracos };
}

async function main() {
  loadEnv();
  await connectMongo();

  const uuids = await collections.progressSnapshots().distinct('uuid');
  console.log(
    `${uuids.length} membro(s) com snapshot. Vãos acima de ${MAX_GAP_H}h são apenas sinalizados.\n`,
  );

  const linhas = [];
  let totalRuido = 0;

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

    totalRuido += guerra.ruido + raid.ruido;
    linhas.push({
      uuid,
      username: atual.username ?? snaps.at(-1).username,
      guerraHoje: atual.guildWars ?? 0,
      guerraReal: guerra.total,
      guerraRuido: guerra.ruido,
      raidHoje: atual.raidsInGuild ?? 0,
      raidReal: raid.total,
      raidRuido: raid.ruido,
      snaps: snaps.length,
      desde: snaps[0].takenAt,
      quedas: guerra.quedas + raid.quedas,
    });
  }

  // Só quem tem algo a mostrar: 145 linhas de zero não ajudam ninguém.
  const visiveis = linhas
    .filter((l) => l.guerraHoje || l.guerraReal || l.raidHoje || l.raidReal || l.quedas)
    .sort((a, b) => b.guerraReal - a.guerraReal || b.raidReal - a.raidReal);

  console.log('membro            | ⚔️ hoje | ⚔️ real | ⚔️ ruído | raid hoje | raid real | raid ruído | quedas');
  for (const l of visiveis) {
    console.log(
      `${l.username.padEnd(17)} | ${String(l.guerraHoje).padStart(7)} | ${String(l.guerraReal).padStart(7)}` +
        ` | ${String(l.guerraRuido).padStart(8)} | ${String(l.raidHoje).padStart(9)} | ${String(l.raidReal).padStart(9)}` +
        ` | ${String(l.raidRuido).padStart(10)} | ${String(l.quedas).padStart(6)}`,
    );
  }
  console.log(`\n(${linhas.length - visiveis.length} membro(s) sem nenhum número, omitidos)`);

  if (totalRuido) {
    console.log(
      `\n${n(totalRuido)} unidade(s) de RUÍDO: subidas que só existiram porque o contador\n` +
        'da API tinha descido antes. Contador de vida não desce — cada queda seguida de\n' +
        'recuperação era contada como progresso novo. A coluna "real" já as ignora.',
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
