// Série crua de um contador ao longo dos snapshots, para ver se ele é monotônico.
//
//   node scripts/inspect-series.js HunterAlas wars
//   node scripts/inspect-series.js --anomalias          # varredura da guilda
//
// POR QUE ISTO EXISTE. `globalData.wars` e `globalData.raids` são contadores de
// VIDA da conta: só podem subir. Se a série gravada nos snapshots desce em
// algum ponto, o valor não veio do jogador — veio da API (resposta parcial,
// nó de cache diferente, campo ausente lido como 0).
//
// E aí a forma de somar importa: `soma dos deltas positivos` descarta as
// descidas e mantém as subidas, então cada oscilação vira ganho permanente. Um
// contador que pisca 122 → 0 → 122 quatro vezes acumula 488. `fim − início`
// ignora o ruído inteiro e devolve o que a pessoa realmente fez no período.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';

const ANOMALIAS = process.argv.includes('--anomalias');
const nick = ANOMALIAS ? null : process.argv[2];
const campo = process.argv[3] || 'wars';
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const quando = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);

/**
 * @param {Array<{takenAt: Date, metrics: object}>} snaps  em ordem cronológica
 * @param {string} campo
 */
function analisar(snaps, campo) {
  const pts = snaps
    .map((s) => ({ at: s.takenAt, v: Number(s.metrics?.[campo]) }))
    .filter((p) => Number.isFinite(p.v));
  if (pts.length < 2) return null;

  let somaUps = 0;
  let quedas = 0;
  let maiorQueda = 0;
  let zeros = 0;
  const saltos = [];

  for (let i = 1; i < pts.length; i += 1) {
    const d = pts[i].v - pts[i - 1].v;
    if (pts[i].v === 0 && pts[i - 1].v > 0) zeros += 1;
    if (d > 0) {
      somaUps += d;
      saltos.push({ at: pts[i].at, de: pts[i - 1].v, para: pts[i].v, d });
    } else if (d < 0) {
      quedas += 1;
      maiorQueda = Math.min(maiorQueda, d);
    }
  }
  saltos.sort((a, b) => b.d - a.d);

  return {
    pontos: pts.length,
    primeiro: pts[0].v,
    ultimo: pts.at(-1).v,
    minimo: Math.min(...pts.map((p) => p.v)),
    maximo: Math.max(...pts.map((p) => p.v)),
    somaUps,
    fimMenosInicio: Math.max(0, pts.at(-1).v - pts[0].v),
    quedas,
    maiorQueda,
    zeros,
    saltos: saltos.slice(0, 5),
    de: pts[0].at,
    ate: pts.at(-1).at,
  };
}

async function detalhe() {
  const alvo = new RegExp(`^${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const stats = await collections.guildStats().findOne({ username: alvo });
  if (!stats) return console.log(`Nenhum membro com o nick "${nick}".`);

  const snaps = await collections
    .progressSnapshots()
    .find({ uuid: stats.uuid }, { projection: { takenAt: 1, metrics: 1 } })
    .sort({ takenAt: 1 })
    .toArray();
  const a = analisar(snaps, campo);
  if (!a) return console.log(`Sem série utilizável de "${campo}" para ${stats.username}.`);

  console.log(`\n=== ${stats.username} · campo "${campo}" ===`);
  console.log(`  ${a.pontos} snapshot(s), de ${quando(a.de)} a ${quando(a.ate)}`);
  console.log(`  primeiro ${n(a.primeiro)} · último ${n(a.ultimo)} · mín ${n(a.minimo)} · máx ${n(a.maximo)}`);
  console.log('');
  console.log(`  soma dos deltas positivos  ${n(a.somaUps)}   <- o que o bot vinha somando`);
  console.log(`  fim − início               ${n(a.fimMenosInicio)}   <- o que a pessoa realmente fez`);
  console.log(`  ruído                      ${n(a.somaUps - a.fimMenosInicio)}`);
  console.log('');
  console.log(`  quedas na série            ${a.quedas}${a.quedas ? `  (maior: ${n(a.maiorQueda)})` : ''}`);
  console.log(`  vezes que zerou            ${a.zeros}`);

  if (a.quedas === 0) {
    console.log('\n  Série monotônica: este contador está saudável.');
  } else {
    console.log(
      '\n  Série NÃO monotônica. Um contador de vida não desce — as quedas são\n' +
        '  resposta ruim da API, e cada subida depois de uma queda foi contada de novo.',
    );
  }

  if (a.saltos.length) {
    console.log('\n  Maiores subidas:');
    for (const s of a.saltos) console.log(`    ${quando(s.at)}  ${n(s.de)} → ${n(s.para)}  (+${n(s.d)})`);
  }
}

async function anomalias() {
  const uuids = await collections.progressSnapshots().distinct('uuid');
  const linhas = [];

  for (const uuid of uuids) {
    const snaps = await collections
      .progressSnapshots()
      .find({ uuid }, { projection: { takenAt: 1, metrics: 1, username: 1 } })
      .sort({ takenAt: 1 })
      .toArray();
    const stats = await collections.guildStats().findOne({ uuid });
    const nome = stats?.username ?? snaps.at(-1)?.username ?? uuid.slice(0, 8);

    for (const c of ['wars', 'raids', 'guildRaids']) {
      const a = analisar(snaps, c);
      if (!a || !a.quedas) continue;
      linhas.push({ nome, campo: c, ...a });
    }
  }

  linhas.sort((a, b) => b.somaUps - b.fimMenosInicio - (a.somaUps - a.fimMenosInicio));
  if (!linhas.length) {
    console.log('Nenhuma série não-monotônica. Os contadores da API estão consistentes.');
    return;
  }

  console.log(`${linhas.length} série(s) com queda — contador de vida que desceu.\n`);
  console.log('membro            | campo      | somando ups | fim−início |      ruído | quedas | zerou');
  for (const l of linhas.slice(0, 40)) {
    console.log(
      `${l.nome.padEnd(17)} | ${l.campo.padEnd(10)} | ${String(n(l.somaUps)).padStart(11)} | ` +
        `${String(n(l.fimMenosInicio)).padStart(10)} | ${String(n(l.somaUps - l.fimMenosInicio)).padStart(10)} | ` +
        `${String(l.quedas).padStart(6)} | ${l.zeros}`,
    );
  }
  const ruido = linhas.reduce((s, l) => s + (l.somaUps - l.fimMenosInicio), 0);
  console.log(`\nRuído total somado indevidamente: ${n(ruido)}.`);
}

async function main() {
  if (!ANOMALIAS && !nick) {
    console.error('Uso: node scripts/inspect-series.js <nick> [campo]  |  --anomalias');
    process.exit(1);
  }
  loadEnv();
  await connectMongo();
  await (ANOMALIAS ? anomalias() : detalhe());
  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
