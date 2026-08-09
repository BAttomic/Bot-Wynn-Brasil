// Quanto o contador por jogador deixa de contar.
//
//   node scripts/war-gap.js            # resumo do período coletado
//   node scripts/war-gap.js --polls    # cada poll em que algo se moveu
//
// A guerra do Wynncraft acaba na prática quando a torre cai: todo mundo vai
// para o /lobby e ninguém espera a finalização formal. Se `globalData.wars` só
// incrementa na finalização, ele ignora justamente quem fez o trabalho.
//
// Aqui os dois contadores independentes ficam lado a lado:
//
//   guildDelta    quanto o contador da GUILDA subiu naquele poll
//   membrosDelta  soma dos incrementos individuais no MESMO poll
//
// Se a guilda sobe e ninguém sobe junto, a tese está confirmada. A razão entre
// as duas somas, ao longo de dias, é o tamanho do furo — e é o número que decide
// se dá para pontuar guerra pelo contador ou não.
//
// A coleção é alimentada pelo watcher (services/watcher.js, auditWar) e expira
// em 30 dias. Precisa de tempo rodando: sem guerra no período, não há o que ler.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';

const DETALHE = process.argv.includes('--polls');
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const quando = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 16);

async function main() {
  loadEnv();
  await connectMongo();

  const docs = await collections.warAudit().find({}).sort({ at: 1 }).toArray();
  if (!docs.length) {
    console.log(
      'Nenhum registro de auditoria ainda.\n' +
        'O watcher só grava quando algum contador de guerra se move — deixe rodando\n' +
        'durante uma noite de guerra e rode de novo.',
    );
    await closeMongo();
    return;
  }

  const guildTotal = docs.reduce((s, d) => s + (d.guildDelta || 0), 0);
  const membrosTotal = docs.reduce((s, d) => s + (d.membrosDelta || 0), 0);
  const guildSemMembro = docs.filter((d) => d.guildDelta > 0 && !d.membrosDelta);
  const membroSemGuild = docs.filter((d) => d.membrosDelta > 0 && !d.guildDelta);
  const juntos = docs.filter((d) => d.guildDelta > 0 && d.membrosDelta > 0);

  console.log(`\nPeríodo: ${quando(docs[0].at)} a ${quando(docs.at(-1).at)} · ${docs.length} poll(s) com movimento\n`);
  console.log(`  guerras contadas pela GUILDA      ${n(guildTotal)}`);
  console.log(`  incrementos de contador de MEMBRO ${n(membrosTotal)}`);
  console.log('');
  console.log(`  polls em que a guilda subiu sozinha   ${guildSemMembro.length}   <- guerra que ninguém levou`);
  console.log(`  polls em que os dois subiram juntos   ${juntos.length}`);
  console.log(`  polls em que só membros subiram       ${membroSemGuild.length}   <- guerra por outra guilda, ou atraso do cache`);

  if (guildTotal > 0) {
    const cobertura = membrosTotal / guildTotal;
    console.log(`\n  cobertura do contador por jogador: ${(cobertura * 100).toFixed(0)}%`);
    if (cobertura < 0.5) {
      console.log(
        '  O contador por jogador perde mais da metade das guerras. Pontuar por ele\n' +
          '  premia quem espera a finalização e ignora quem vai para o /lobby.',
      );
    } else if (cobertura > 1.5) {
      console.log(
        '  Mais incrementos individuais que guerras da guilda: parte é guerra feita\n' +
          '  por OUTRA guilda (o contador é da conta), parte pode ser ruído da API.',
      );
    } else {
      console.log('  Os dois sinais andam juntos — o contador por jogador está representativo.');
    }
  }

  if (DETALHE) {
    console.log('\nquando            | guilda | membros | quem');
    for (const d of docs) {
      const quem = (d.membros || []).map((m) => `${m.username}+${m.delta}`).join(', ') || '—';
      console.log(
        `${quando(d.at)} | ${String(d.guildDelta ?? 0).padStart(6)} | ${String(d.membrosDelta ?? 0).padStart(7)} | ${quem}`,
      );
    }
  } else {
    console.log('\n(--polls mostra poll a poll)');
  }

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
