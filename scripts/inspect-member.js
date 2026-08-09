// Raio-x de UM membro: de onde vem cada número que o painel mostra.
//
//   node scripts/inspect-member.js Ninja
//
// Só lê. Serve para responder "o placar diz X, e X está errado — de onde saiu
// esse X?", separando as quatro camadas que podem divergir entre si:
//
//   1. progressSnapshots     o que a API disse, e quando
//   2. pointsEvents          o livro-razão (a quantidade BRUTA de cada fato)
//   3. guildStats / seasonParticipation
//                            contadores materializados. Os `$inc` daqui NÃO
//                            derivam do livro-razão: se divergirem, é bug ou
//                            reset pela metade
//   4. leaderboardCache      o que o painel realmente exibe. Se estiver velho,
//                            o número na tela não corresponde a nada no banco

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';
import { getActiveSeason } from '../src/services/seasons.js';

const nick = process.argv[2];
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const quando = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '—');

async function main() {
  if (!nick) {
    console.error('Uso: node scripts/inspect-member.js <nick>');
    process.exit(1);
  }
  loadEnv();
  await connectMongo();

  // Nick com a caixa que o jogador usa nem sempre é a que está gravada.
  const alvo = new RegExp(`^${nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const stats = await collections.guildStats().findOne({ username: alvo });
  if (!stats) {
    console.log(`Nenhum membro com o nick "${nick}" em guildStats.`);
    await closeMongo();
    return;
  }
  const { uuid } = stats;
  const ativa = (await getActiveSeason())?.seasonId ?? null;
  console.log(`\n=== ${stats.username} (${uuid}) — season ativa: ${ativa ?? 'nenhuma'} ===`);

  console.log('\n[3] guildStats (contadores do placar ACUMULADO)');
  console.log(`  pontos             ${n(stats.points)}`);
  console.log(`  guildWars          ${n(stats.guildWars)}      <- coluna ⚔️, acumulador nosso`);
  console.log(`  guildRaids         ${n(stats.guildRaids)}      <- coluna 🛡️, ABSOLUTO da API`);
  console.log(`  raidsInGuild       ${n(stats.raidsInGuild)}`);
  console.log(`  contributed        ${n(stats.contributed)}`);
  console.log(`  aspectBaseRaids    ${n(stats.aspectBaseRaids)}`);

  console.log('\n[3] seasonParticipation (contadores por season)');
  const rows = await collections.seasonParticipation().find({ uuid }).sort({ seasonId: 1 }).toArray();
  if (!rows.length) console.log('  — nenhuma linha —');
  for (const r of rows) {
    const marca = r.seasonId === ativa ? ' *ATIVA*' : '';
    console.log(
      `  ${r.seasonId}${marca}: ${n(r.points)} pts · guerras ${n(r.warsFought)} · ` +
        `guildRaids ${n(r.guildRaidsDelta)} · raids ${n(r.raidsDelta)} · XP ${n(r.contributedDelta)}`,
    );
  }

  console.log('\n[2] pointsEvents (livro-razão, quantidade bruta somada)');
  const porTipo = await collections
    .pointsEvents()
    .aggregate([
      { $match: { uuid } },
      {
        $group: {
          _id: { seasonId: '$seasonId', type: '$type', baseline: { $ifNull: ['$meta.baseline', false] } },
          docs: { $sum: 1 },
          qty: { $sum: '$qty' },
          ultimo: { $max: '$at' },
        },
      },
      { $sort: { '_id.seasonId': 1, '_id.type': 1 } },
    ])
    .toArray();
  if (!porTipo.length) console.log('  — nenhum evento —');
  for (const g of porTipo) {
    console.log(
      `  [${g._id.seasonId ?? 'sem season'}] ${g._id.type}${g._id.baseline ? ' (BASELINE)' : ''}: ` +
        `${g.docs} evento(s), qty ${n(g.qty)}, último ${quando(g.ultimo)}`,
    );
  }

  // Um evento único e enorme é a assinatura de despejo de histórico.
  const maiores = await collections
    .pointsEvents()
    .find({ uuid, type: { $in: ['war', 'raid', 'guildRaid'] } })
    .sort({ qty: -1 })
    .limit(5)
    .toArray();
  if (maiores.length) {
    console.log('\n[2] maiores lançamentos individuais (despejo de histórico aparece aqui)');
    for (const e of maiores) {
      console.log(
        `  ${quando(e.at)} ${e.type} +${n(e.qty)}` +
          `${e.meta?.baseline ? ' (BASELINE)' : ''} [${e.seasonId ?? 'sem season'}]`,
      );
    }
  }

  console.log('\n[1] progressSnapshots (os 5 últimos, o que a API disse)');
  const snaps = await collections
    .progressSnapshots()
    .find({ uuid })
    .sort({ takenAt: -1 })
    .limit(5)
    .toArray();
  const total = await collections.progressSnapshots().countDocuments({ uuid });
  console.log(`  ${total} snapshot(s) no histórico`);
  for (const s of snaps) {
    const m = s.metrics || {};
    console.log(
      `  ${quando(s.takenAt)}  wars ${n(m.wars)} · raids ${n(m.raids)} · ` +
        `guildRaids ${m.guildRaids ?? 'AUSENTE'} · XP ${n(m.contributed)}`,
    );
  }

  console.log('\n[4] leaderboardCache (o que o painel EXIBE)');
  const boards = [
    ['cat:guildraid', 'Raids · acumulado'],
    [ativa ? `cat:guildraid:season:${ativa}` : null, 'Raids · season'],
    ['alltime', 'Pontos · acumulado'],
    [ativa ? `season:${ativa}` : null, 'Pontos · season'],
  ];
  for (const [id, rotulo] of boards) {
    if (!id) continue;
    const doc = await collections.leaderboardCache().findOne({ _id: id });
    if (!doc) {
      console.log(`  ${rotulo}: tabela inexistente`);
      continue;
    }
    const i = (doc.rows ?? []).findIndex((r) => r.uuid === uuid);
    const r = i >= 0 ? doc.rows[i] : null;
    // Tabela de categoria guarda `value`; a de pontos guarda a linha inteira.
    let valor = '(fora do top 15)';
    if (r) {
      valor =
        r.value !== undefined
          ? `#${i + 1} com ${n(r.value)}`
          : `#${i + 1} com ${n(r.points)} pts · ⚔️ ${n(r.guildWars)} · 🛡️ ${n(r.guildRaids)}`;
    }
    console.log(`  ${rotulo}: montada ${quando(doc.builtAt)} · ${valor}`);
  }

  console.log(
    '\nSe [4] discorda de [3], a tabela está velha: rode /leaderboard atualizar.\n' +
      'Se [3] discorda de [2], o contador foi somado por $inc e não derivou do livro-razão — é o que o reset-stats.js conserta.\n',
  );
  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
