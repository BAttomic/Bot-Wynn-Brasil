// Verifica tudo que dá para verificar sem ligar o bot no Discord.
//
//   node scripts/selftest.js
//
// Bate na API real do Wynncraft e usa um banco Mongo DESCARTÁVEL (criado e
// apagado ao final). Não toca no banco de produção nem no servidor do Discord.

import { loadEnv } from '../src/config/env.js';

let pass = 0;
let fail = 0;

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n       esperado ${JSON.stringify(want)}, veio ${JSON.stringify(got)}`}`);
  ok ? (pass += 1) : (fail += 1);
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main() {
  process.env.MONGO_DB = `wynn_selftest_${Date.now()}`;
  process.env.DISCORD_GUILD_ID = '000000000000000000';
  process.env.WYNN_GUILD_PREFIX = process.env.WYNN_GUILD_PREFIX || 'WnBR';
  loadEnv();

  const { wynn } = await import('../src/wynn/api.js');
  const reg = await import('../src/services/registration.js');
  const terr = await import('../src/services/territories.js');
  const gd = await import('../src/services/guildData.js');
  const { detectGuildRaids } = await import('../src/services/watcher.js');

  // ---------------------------------------------------------------- API
  section('1. API do Wynncraft responde');
  const wnbr = await wynn.guildByPrefix('WnBR');
  const gsw = await wynn.guildByPrefix('GsW');
  check('guilda WnBR encontrada', wnbr?.name, 'Wynn Brasil');
  check('guilda GsW encontrada', gsw?.name, 'Guardians of Wynn');
  check('nick inexistente devolve null', await wynn.player('nick_que_nao_existe_zzz'), null);

  section('2. Missão semanal: só na API autenticada, e só da nossa guilda');
  const RANKS = gd.RANKS;
  const flat = (g) => RANKS.flatMap((r) => Object.values(g.members[r] || {}));
  const preenchido = (g) => flat(g).filter((m) => m.weekly && Object.keys(m.weekly).length).length;
  const temChave = !!process.env.WYNN_API_KEY;

  check('há chave de API configurada', temChave, true);
  if (temChave) {
    check('nossa guilda expõe a missão de todo mundo', preenchido(wnbr), flat(wnbr).length);
    check('guilda alheia (GsW) não expõe nada', preenchido(gsw), 0);
    const campos = new Set(flat(wnbr).flatMap((m) => Object.keys(m.weekly)));
    check('campos são completed + streak', [...campos].sort(), ['completed', 'streak']);
  }

  const anon = await (await fetch('https://api.wynncraft.com/v3/guild/prefix/WnBR')).json();
  check('sem chave, a missão some para todos', preenchido(anon), 0);

  section('3. Classificação de registro (cargo por guilda)');
  const donoGsw = Object.keys(gsw.members.owner)[0];
  const donoWnbr = Object.keys(wnbr.members.owner)[0];
  check(`${donoGsw} (GsW) => banned`, reg.classifyPlayer(await wynn.player(donoGsw)), 'banned');
  check(`${donoWnbr} (WnBR) => member`, reg.classifyPlayer(await wynn.player(donoWnbr)), 'member');
  check('sem guilda => neutral', reg.classifyPlayer({ guild: null }), 'neutral');
  check('GsW com prefixo trocado ainda => banned', reg.classifyPlayer({ guild: { uuid: reg.blacklistGuild().uuid, prefix: 'ZZZ' } }), 'banned');

  section('4. Multiplicador de território (fórmula da wiki)');
  check('normal, 0 fronteiras => x1.0', terr.towerMultiplier({ connections: 0 }), 1);
  check('normal, 4 fronteiras => x2.2', Number(terr.towerMultiplier({ connections: 4 }).toFixed(2)), 2.2);
  check('QG, 0 e 0 => x1.5', terr.towerMultiplier({ connections: 0, externals: 0, isHq: true }), 1.5);
  check('QG, 4 fronteiras e 10 externals => x8.8', Number(terr.towerMultiplier({ connections: 4, externals: 10, isHq: true }).toFixed(2)), 8.8);

  const mapa = await wynn.territoryList();
  const hqs = Object.entries(mapa).filter(([, v]) => v.hq === true);
  const valores = hqs.map(([n]) => terr.captureValue(mapa, n));
  const totalDe = (p) => Object.values(mapa).filter((x) => x.guild?.prefix === p).length;
  check('há QGs no mapa ao vivo', hqs.length > 0, true);
  check('nenhum QG tem mais externals que territórios da guilda', valores.every((v) => v.externals <= totalDe(v.defender)), true);
  check('todo QG vale pelo menos x1.5', valores.every((v) => v.multiplier >= 1.5), true);
  console.log(`       (${hqs.length} QGs; mais caro x${Math.max(...valores.map((v) => v.multiplier)).toFixed(2)})`);

  section('5. Guild raid: grupos distintos não se misturam');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const prev = clone(wnbr);
  const curr = clone(wnbr);
  const RAID = 'The Nameless Anomaly';
  const comCGR = (g) => flat(g).filter((m) => m.globalData?.currentGuildRaids?.list);
  const bump = (m) => { m.globalData.currentGuildRaids.list[RAID] = (m.globalData.currentGuildRaids.list[RAID] || 0) + 1; };
  const alvos = comCGR(curr);
  alvos.slice(0, 4).forEach((m) => { m.server = 'WC1'; bump(m); });
  alvos.slice(4, 8).forEach((m) => { m.server = 'WC42'; bump(m); });
  alvos[9].server = null; comCGR(prev)[9].server = null; bump(alvos[9]);

  const grupos = detectGuildRaids(prev, curr);
  check('3 grupos (WC1, WC42, sem-mundo)', grupos.length, 3);
  check('nenhum grupo com mais de 4 membros', grupos.every((g) => g.members.length <= 4), true);
  check('primeiro poll não anuncia nada', detectGuildRaids(null, curr).length, 0);
  check('sem mudança não anuncia nada', detectGuildRaids(prev, clone(wnbr)).length, 0);

  section('6. Ordenação de cargos (peakRank)');
  check('capitão > recruta', gd.isHigherRank('captain', 'recruit'), true);
  check('recruta não > capitão', gd.isHigherRank('recruit', 'captain'), false);
  check('capitão > nenhum cargo', gd.isHigherRank('captain', undefined), true);
  check('capitão não > capitão', gd.isHigherRank('captain', 'captain'), false);

  // -------------------------------------------------------- Livro-razão
  section('7. Pontos derivam do histórico (banco descartável)');
  const { connectMongo, closeMongo, collections, getDb } = await import('../src/db/mongo.js');
  const { setParam } = await import('../src/config/guildConfig.js');
  const P = await import('../src/services/points.js');

  await connectMongo();
  try {
    await collections.seasons().insertOne({ seasonId: 'S1', active: true, startAt: new Date() });
    const snapAt = new Date('2026-07-01');
    const A = { uuid: 'uuid-a', username: 'Alice' };
    const B = { uuid: 'uuid-b', username: 'Bob' };

    await P.recordEvent({ ...A, type: 'war', qty: 3, meta: { snapshotAt: snapAt } });
    await P.recordEvent({ ...B, type: 'guildRaid', qty: 2, meta: { snapshotAt: snapAt } });
    await P.recordEvent({ ...B, type: 'contribution', qty: 5_000_000, meta: { snapshotAt: snapAt } });
    await P.recordEvent({ ...B, type: 'territory', qty: 2.2 });

    const pts = async (uuid) => (await collections.guildStats().findOne({ uuid }))?.points;
    const gid = process.env.DISCORD_GUILD_ID;

    await P.recomputePoints();
    check('Alice 3 guerras x10 = 30', await pts('uuid-a'), 30);
    check('Bob 2 gr + 5M + captura x2.2 = 79', await pts('uuid-b'), 79);

    await setParam(gid, 'pointsWeights', { war: 20, raid: 5, guildRaid: 15, contribPerMillion: 1, territoryBase: 20 });
    await P.recomputePoints();
    check('peso 10→20 reescreve o passado da Alice', await pts('uuid-a'), 60);
    check('e não mexe no Bob', await pts('uuid-b'), 79);

    await setParam(gid, 'territoryMultiplierCap', 1.5);
    await P.recomputePoints();
    check('teto 8→1.5 reescreve só a captura do Bob', await pts('uuid-b'), 65);

    const dup = await P.recordEvent({ ...A, type: 'war', qty: 3, meta: { snapshotAt: snapAt } });
    await P.recomputePoints();
    check('mesmo snapshot recusado', dup, false);
    check('e Alice não dobrou', await pts('uuid-a'), 60);

    await P.awardPoints('uuid-a', 'Alice', 25, 'evento');
    check('concessão manual vale na hora', await pts('uuid-a'), 85);

    await P.rebuildLeaderboards();
    const lb = await P.pointsLeaderboard('alltime');
    check('leaderboard materializado e ordenado', lb.rows.map((r) => r.username), ['Alice', 'Bob']);
    check('leaderboard tem data de apuração', !!lb.builtAt, true);
  } finally {
    await getDb().dropDatabase();
    await closeMongo();
  }

  console.log(`\n\x1b[1m${pass} passaram, ${fail} falharam\x1b[0m`);
  console.log('Banco de teste removido. Nada foi tocado em produção.\n');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('\nselftest quebrou:', e);
  process.exit(1);
});
