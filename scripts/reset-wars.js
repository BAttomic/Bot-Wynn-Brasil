// Zera o histórico de guerra: eventos, contadores crus e capturas de território.
//
//   node scripts/reset-wars.js --dry     # mostra o que apagaria, sem tocar
//   node scripts/reset-wars.js           # apaga e reapura
//
// Por que não basta apagar os eventos: `guildStats.guildWars` e
// `seasonParticipation.warsFought` são somados por $inc no snapshot diário, e
// NÃO derivam do livro-razão. `recomputePoints` só reescreve `points` e
// `weeklyObjectives`. Apagar só os eventos zeraria os pontos e deixaria a aba
// "Guerras" do leaderboard exibindo os números velhos.
//
// Território entra junto de propósito: o evento de captura paga apenas o
// EXCEDENTE do multiplicador (`(mult − 1) × territoryBase`), contando com a base
// vinda da guerra. Apagar a guerra e manter a captura deixaria no ranking um
// resto de ponto sem a metade que lhe dava sentido.
//
// Os snapshots ficam INTACTOS, e isso é o que torna o reset seguro: o delta do
// próximo snapshot sai da comparação com `progressSnapshots`, nunca com
// `guildStats`. O passado não é recreditado, e XP contribuído, guild raids e
// objetivos semanais seguem valendo integralmente.
//
// O painel fixo se reedita sozinho (job `panels`, a cada 5 min). Para não
// esperar, a staff roda `/leaderboard atualizar`.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';
import { recomputePoints, rebuildLeaderboards } from '../src/services/points.js';

const DRY = process.argv.includes('--dry');
const p = (s) => console.log(`${DRY ? '[dry] ' : ''}${s}`);

/** Tipos de evento que somem. Ver eventPoints() em services/points.js. */
const TYPES = ['war', 'territory'];

async function main() {
  loadEnv();
  await connectMongo();

  const events = collections.pointsEvents();
  const stats = collections.guildStats();
  const part = collections.seasonParticipation();
  const caps = collections.territoryCaptures();

  // ---- Retrato do que será apagado ----
  const porTipo = await events
    .aggregate([
      { $match: { type: { $in: TYPES } } },
      { $group: { _id: '$type', docs: { $sum: 1 }, qty: { $sum: '$qty' } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  if (!porTipo.length) {
    console.log('Nenhum evento de guerra ou território no livro-razão.');
  }
  for (const t of porTipo) {
    console.log(`  ${t._id}: ${t.docs} evento(s), qty somada ${Number(t.qty).toFixed(2)}`);
  }

  const comGuerras = await stats.countDocuments({ guildWars: { $gt: 0 } });
  const linhasSeason = await part.countDocuments({ warsFought: { $gt: 0 } });
  const capturas = await caps.countDocuments({});
  console.log(
    `\n${comGuerras} membro(s) com guildWars > 0, ${linhasSeason} linha(s) de season com warsFought > 0, ${capturas} captura(s) registrada(s).`,
  );

  // Os dez maiores servem de conferência: se um nome aqui não bate com a sua
  // memória da guilda, o reset não é o problema — a contagem é.
  const top = await stats
    .find({ guildWars: { $gt: 0 } })
    .sort({ guildWars: -1 })
    .limit(10)
    .toArray();
  if (top.length) {
    console.log('\nMaiores contadores de guerra hoje:');
    for (const r of top) {
      console.log(`  ${r.username}: ${r.guildWars} guerra(s), ${r.points ?? 0} pts`);
    }
  }

  if (DRY) {
    p('\nnada foi alterado.');
    await closeMongo();
    return;
  }

  // ---- Reset ----
  const del = await events.deleteMany({ type: { $in: TYPES } });
  console.log(`\n${del.deletedCount} evento(s) apagado(s) do livro-razão.`);

  // O $unset ficaria fora: o snapshot usa $inc, que trata campo ausente como 0,
  // mas o leaderboard filtra por `{ $gt: 0 }` e o /points show lê o valor cru.
  // Zerar explicitamente mantém os dois legíveis.
  const zStats = await stats.updateMany({}, { $set: { guildWars: 0 } });
  const zPart = await part.updateMany({}, { $set: { warsFought: 0 } });
  console.log(
    `guildWars zerado em ${zStats.modifiedCount} membro(s), warsFought em ${zPart.modifiedCount} linha(s) de season.`,
  );

  const delCaps = await caps.deleteMany({});
  console.log(`${delCaps.deletedCount} captura(s) de território apagada(s).`);

  const { members, seasonRows } = await recomputePoints();
  const { categories, seasons } = await rebuildLeaderboards();
  console.log(
    `\nPontos recomputados (${members} membro(s), ${seasonRows} linha(s) de season) e ` +
      `${categories} categoria(s) × ${seasons + 1} escopo(s) reconstruída(s).`,
  );
  console.log('Painel se reedita em até 5 min, ou rode /leaderboard atualizar.');

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
