// Zera a contagem de GUERRAS e RAIDS: eventos, contadores crus e capturas de
// território. Tudo passa a contar do zero a partir do próximo snapshot.
//
//   node scripts/reset-stats.js --dry     # mostra o que apagaria, sem tocar
//   node scripts/reset-stats.js           # apaga e reapura
//
// O QUE SOBREVIVE (de propósito):
//   • XP contribuído e objetivos semanais — os pontos deles continuam valendo.
//   • Pontos manuais (/points dar) — concessão da staff não é apuração.
//   • progressSnapshots — é o que torna o reset seguro: o delta do próximo
//     snapshot sai da comparação com o snapshot anterior, NUNCA com guildStats.
//     O passado não é recreditado, e o próximo ciclo já conta certo.
//   • Tomes, aspects entregues, vínculos, empréstimos, eventos e sorteios.
//   • guildStats.guildRaids — é o `currentGuildRaids` ABSOLUTO da API (a vida
//     inteira do membro nesta guilda), não um acumulador nosso. Zerá-lo seria
//     inútil (o próximo snapshot o reescreve com o mesmo valor) e quebraria os
//     aspects, que contam do zero por `guildRaids − aspectBaseRaids`. A coluna
//     🛡️ do painel segue mostrando o total da API; o que zera é a PONTUAÇÃO.
//
// Por que não basta apagar os eventos: `guildStats.guildWars`, `raidsInGuild` e
// os campos de `seasonParticipation` são somados por $inc no snapshot e NÃO
// derivam do livro-razão. `recomputePoints` só reescreve `points` e
// `weeklyObjectives`. Apagar só os eventos zeraria os pontos e deixaria as abas
// "Guerras" e "Guild Raids" do leaderboard exibindo os números velhos.
//
// Território entra junto de propósito: o evento de captura paga apenas o
// EXCEDENTE do multiplicador (`(mult − 1) × territoryBase`), contando com a base
// vinda da guerra. Apagar a guerra e manter a captura deixaria no ranking um
// resto de ponto sem a metade que lhe dava sentido.
//
// O painel fixo se reedita sozinho (job `panels`, a cada 5 min). Para não
// esperar, a staff roda `/leaderboard atualizar`.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';
import { recomputePoints, rebuildLeaderboards } from '../src/services/points.js';

const DRY = process.argv.includes('--dry');
const p = (s) => console.log(`${DRY ? '[dry] ' : ''}${s}`);

/** Tipos de evento que somem. Ver eventPoints() em services/points.js. */
const TYPES = ['war', 'territory', 'raid', 'guildRaid'];

/** Contadores crus por membro, em guildStats. */
const STATS_FIELDS = ['guildWars', 'raidsInGuild'];

/** Contadores crus por season, em seasonParticipation. */
const SEASON_FIELDS = ['warsFought', 'raidsDelta', 'guildRaidsDelta'];

/** @param {string[]} fields @returns {Record<string, 0>} */
const zerar = (fields) => Object.fromEntries(fields.map((f) => [f, 0]));

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
    console.log('Nenhum evento de guerra, raid ou território no livro-razão.');
  }
  for (const t of porTipo) {
    console.log(`  ${t._id}: ${t.docs} evento(s), qty somada ${Number(t.qty).toFixed(2)}`);
  }

  const comGuerras = await stats.countDocuments({ guildWars: { $gt: 0 } });
  const comRaids = await stats.countDocuments({ raidsInGuild: { $gt: 0 } });
  const linhasSeason = await part.countDocuments({
    $or: SEASON_FIELDS.map((f) => ({ [f]: { $gt: 0 } })),
  });
  const capturas = await caps.countDocuments({});
  console.log(
    `\n${comGuerras} membro(s) com guildWars > 0, ${comRaids} com raidsInGuild > 0, ` +
      `${linhasSeason} linha(s) de season a zerar, ${capturas} captura(s) registrada(s).`,
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
      console.log(
        `  ${r.username}: ${r.guildWars} guerra(s), ${r.raidsInGuild ?? 0} raid(s), ${r.points ?? 0} pts`,
      );
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
  const zStats = await stats.updateMany({}, { $set: zerar(STATS_FIELDS) });
  const zPart = await part.updateMany({}, { $set: zerar(SEASON_FIELDS) });
  console.log(
    `Contadores zerados em ${zStats.modifiedCount} membro(s) (${STATS_FIELDS.join(', ')}) ` +
      `e ${zPart.modifiedCount} linha(s) de season (${SEASON_FIELDS.join(', ')}).`,
  );

  // `aspectBaseRaids` e `aspectsDelivered` NÃO são tocados. Aspect é dívida da
  // guilda com o membro, não pontuação: quem já fez as raids continua com o que
  // tem a receber, independente de a apuração de pontos ter sido zerada.
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
