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

  section('6. Perdão de inatividade pela contribuição');
  const inat = await import('../src/services/inactivity.js');
  const ip = { inactivityDays: 7, inactivityForgivenessPerPoints: 1000, inactivityForgivenessMaxDays: 30 };

  check('0 pontos => limite base de 7d', inat.allowanceDays(0, ip), 7);
  check('999 pontos ainda não compram 1 dia', inat.forgivenessDays(999, ip), 0);
  check('1000 pontos => +1 dia', inat.forgivenessDays(1000, ip), 1);
  check('10.000 pontos => +10 dias (7+10=17)', inat.allowanceDays(10_000, ip), 17);
  check('teto de 30 dias', inat.forgivenessDays(9_999_999, ip), 30);
  check('pontos negativos não tiram dias', inat.forgivenessDays(-500, ip), 0);

  const offline10 = new Date(Date.now() - 10 * 86_400_000);
  const novato = inat.evaluate({ username: 'Novato', lastJoin: offline10, online: false }, 0, ip);
  const veterano = inat.evaluate({ username: 'Veterano', lastJoin: offline10, online: false }, 10_000, ip);
  check('novato com 10d offline já pode ser expulso', novato.kickable, true);
  check('veterano com 10d offline está protegido', veterano.kickable, false);
  check('veterano ganhou 10 dias de perdão', veterano.forgiveness, 10);
  check('online nunca é expulsável', inat.evaluate({ username: 'On', lastJoin: offline10, online: true }, 0, ip).kickable, false);
  check('sem lastJoin não é expulsável', inat.evaluate({ username: '?', lastJoin: null, online: false }, 0, ip).kickable, false);

  section('7. Ordenação de cargos (peakRank)');
  check('capitão > recruta', gd.isHigherRank('captain', 'recruit'), true);
  check('recruta não > capitão', gd.isHigherRank('recruit', 'captain'), false);
  check('capitão > nenhum cargo', gd.isHigherRank('captain', undefined), true);
  check('capitão não > capitão', gd.isHigherRank('captain', 'captain'), false);

  // -------------------------------------------------------- Livro-razão
  section('8. Pontos derivam do histórico (banco descartável)');
  const { connectMongo, closeMongo, collections, getDb } = await import('../src/db/mongo.js');
  const { setParam } = await import('../src/config/guildConfig.js');
  const P = await import('../src/services/points.js');

  await connectMongo();
  try {
    // Regressão: config antiga no banco não pode apagar pesos novos.
    // Um merge raso zeraria guildRaid/weekly/territoryBase silenciosamente.
    const { getConfig } = await import('../src/config/guildConfig.js');
    await collections.config().insertOne({
      guildDiscordId: process.env.DISCORD_GUILD_ID,
      channels: {},
      roles: {},
      params: { pointsWeights: { war: 10, raid: 5, contribPerMillion: 1 } }, // schema velho
    });
    const velha = await getConfig(process.env.DISCORD_GUILD_ID);
    check('peso antigo do banco é preservado', velha.params.pointsWeights.raid, 5);
    check('guildRaid volta do padrão (era undefined)', velha.params.pointsWeights.guildRaid, 10);
    check('weekly volta do padrão (era undefined)', velha.params.pointsWeights.weekly, 30);
    check('territoryBase volta do padrão (era undefined)', velha.params.pointsWeights.territoryBase, 10);
    check('params de topo novos também entram', velha.params.inactivityForgivenessPerPoints, 1000);

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

    // Tabela oficial: 1M xp = 1 pt · graid = 10 · war = 10 × mult · weekly = 30 × streak
    const base = { war: 10, raid: 0, guildRaid: 10, weekly: 30, contribPerMillion: 1, territoryBase: 10 };
    const wp = (extra = {}) => ({ type: 'weekly', qty: 1, meta: { streak: 1 }, ...extra });

    check('1M de XP = 1 ponto', P.eventPoints({ type: 'contribution', qty: 1_000_000 }, { pointsWeights: base }), 1);
    check('1 guild raid = 10 pontos', P.eventPoints({ type: 'guildRaid', qty: 1 }, { pointsWeights: base }), 10);
    check('raid comum não pontua', P.eventPoints({ type: 'raid', qty: 5 }, { pointsWeights: base }), 0);

    // Guerra = base 10; captura paga só o excedente. Somados, dão 10 × mult.
    const capParams = { pointsWeights: base, territoryMultiplierCap: 8 };
    const guerra = P.eventPoints({ type: 'war', qty: 1 }, capParams);
    const excedente = P.eventPoints({ type: 'territory', qty: 2.2 }, capParams);
    check('guerra sozinha = 10', guerra, 10);
    check('captura x2.2 paga só o excedente = 12', Number(excedente.toFixed(2)), 12);
    check('guerra + captura = 10 × 2.2 = 22', Number((guerra + excedente).toFixed(2)), 22);
    check('captura sem fronteiras (x1.0) não dá bônus', P.eventPoints({ type: 'territory', qty: 1 }, capParams), 0);

    // Weekly: 30 base, +10% por semana seguida, teto +100%.
    const wParams = { pointsWeights: base, weeklyStreakBonusPerWeek: 0.1, weeklyStreakBonusMax: 1 };
    check('weekly streak 1 = 30', P.eventPoints(wp(), wParams), 30);
    check('weekly streak 3 = 30 × 1.2 = 36', Number(P.eventPoints(wp({ meta: { streak: 3 } }), wParams).toFixed(2)), 36);
    check('weekly streak 11 = 30 × 2.0 = 60 (teto)', P.eventPoints(wp({ meta: { streak: 11 } }), wParams), 60);
    check('weekly streak 50 continua 60 (teto)', P.eventPoints(wp({ meta: { streak: 50 } }), wParams), 60);

    await P.recomputePoints();
    check('Alice 3 guerras × 10 = 30', await pts('uuid-a'), 30);
    check('Bob: 2 graid(20) + 5M(5) + excedente(12) = 37', await pts('uuid-b'), 37);

    await setParam(gid, 'pointsWeights', { ...base, war: 20 });
    await P.recomputePoints();
    check('peso 10→20 reescreve o passado da Alice', await pts('uuid-a'), 60);
    check('e não mexe no Bob', await pts('uuid-b'), 37);

    await setParam(gid, 'territoryMultiplierCap', 1.5);
    await P.recomputePoints();
    check('teto 8→1.5 reescreve só a captura do Bob', await pts('uuid-b'), 30);

    const dup = await P.recordEvent({ ...A, type: 'war', qty: 3, meta: { snapshotAt: snapAt } });
    await P.recomputePoints();
    check('mesmo snapshot recusado', dup, false);
    check('e Alice não dobrou', await pts('uuid-a'), 60);

    await P.awardPoints('uuid-a', 'Alice', 25, 'evento');
    check('concessão manual vale na hora', await pts('uuid-a'), 85);
    await setParam(gid, 'territoryMultiplierCap', 8); // restaura para as seções seguintes

    await P.rebuildLeaderboards();
    const lb = await P.pointsLeaderboard('alltime');
    check('leaderboard materializado e ordenado', lb.rows.map((r) => r.username), ['Alice', 'Bob']);
    check('leaderboard tem data de apuração', !!lb.builtAt, true);

    // ------------------------------------------ Leaderboards por categoria
    section('9. Leaderboards por categoria (números crus)');
    await collections.guildStats().updateOne({ uuid: 'uuid-a' }, { $set: { guildWars: 40, contributed: 9_000_000, guildRaids: 1, weeklyObjectives: 7 } });
    await collections.guildStats().updateOne({ uuid: 'uuid-b' }, { $set: { guildWars: 5, contributed: 50_000_000, guildRaids: 12, weeklyObjectives: 2 } });
    await P.rebuildLeaderboards();

    const top = async (k) => (await P.categoryLeaderboard(k)).rows.map((r) => `${r.username}:${r.value}`);
    check('guerras: Alice na frente', await top('war'), ['Alice:40', 'Bob:5']);
    check('XP: Bob na frente', await top('xp'), ['Bob:50000000', 'Alice:9000000']);
    check('guild raids: Bob na frente', await top('guildraid'), ['Bob:12', 'Alice:1']);
    check('objetivos semanais: Alice na frente', await top('weekly'), ['Alice:7', 'Bob:2']);
    check('categoria inexistente devolve vazio', (await P.categoryLeaderboard('xablau')).rows, []);

    const LP = await import('../src/services/leaderboardPanel.js');
    const painel = await LP.buildLeaderboardPanel();
    const menu = painel.components[0].toJSON().components[0];
    check('painel mostra pontos por padrão', painel.embeds[0].title.includes('Pontos'), true);
    check('seletor tem pontos + todas as categorias', menu.options.length, 1 + Object.keys(P.CATEGORIES).length);
    check('seletor dentro do limite de 25 opções', menu.options.length <= 25, true);
    check('descrições do seletor ≤ 100 chars', menu.options.every((o) => (o.description || '').length <= 100), true);
    check('nunca mais de 15 linhas', painel.embeds[0].description.split('\n').length <= 15, true);
    check('botão Meus pontos presente', painel.components[1].toJSON().components[0].custom_id, LP.ME_ID);
    check('opção "pontos" marcada como selecionada', menu.options.find((o) => o.value === 'pontos').default, true);

    // A visão do painel é PÚBLICA: precisa sobreviver ao job que o republica.
    await collections.watcherState().updateOne({ _id: 'leaderboardPanel' }, { $set: { view: 'xp' } }, { upsert: true });
    const emXp = await LP.buildLeaderboardPanel();
    check('painel republicado respeita a visão salva', emXp.embeds[0].title.includes('XP'), true);
    const menuXp = emXp.components[0].toJSON().components[0];
    check('seletor marca a visão salva', menuXp.options.find((o) => o.value === 'xp').default, true);
    check('e desmarca a anterior', menuXp.options.find((o) => o.value === 'pontos').default, false);

    await collections.watcherState().updateOne({ _id: 'leaderboardPanel' }, { $set: { view: 'inexistente' } });
    const invalida = await LP.buildLeaderboardPanel();
    check('visão inválida cai no padrão', invalida.embeds[0].title.includes('Pontos'), true);
    await collections.watcherState().deleteOne({ _id: 'leaderboardPanel' });

    // ---------------------------------------------------- Banimentos
    section('10. Banimento pega UUID e Discord, e é permanente');
    const B2 = await import('../src/services/bans.js');
    await B2.recordBan({ uuid: 'uuid-gsw', username: 'Fulano', discordId: 'discord-1', reason: 'teste' });

    check('acha pelo uuid', !!(await B2.findBan({ uuid: 'uuid-gsw' })), true);
    check('acha pelo discord', !!(await B2.findBan({ discordId: 'discord-1' })), true);
    check('não acha um terceiro', await B2.findBan({ uuid: 'uuid-limpo', discordId: 'discord-9' }), null);

    // Troca de conta do Minecraft: mesmo Discord, uuid novo.
    check('mesmo Discord + conta nova => banido', await B2.isBanned({ uuid: 'uuid-novo', discordId: 'discord-1' }), true);
    // Troca de Discord: mesmo uuid, Discord novo.
    check('mesmo uuid + Discord novo => banido', await B2.isBanned({ uuid: 'uuid-gsw', discordId: 'discord-2' }), true);

    // Anexar o par novo faz a teia crescer.
    await B2.recordBan({ uuid: 'uuid-gsw', username: 'FulanoNovoNick', discordId: 'discord-2', reason: 'teste' });
    const doc = await B2.findBan({ uuid: 'uuid-gsw' });
    check('dois Discords no mesmo registro', doc.discordIds.sort(), ['discord-1', 'discord-2']);
    check('dois nicks no mesmo registro', doc.usernames.sort(), ['Fulano', 'FulanoNovoNick']);
    check('um registro só (sem duplicar)', await B2.countBans(), 1);

    const idx = await B2.loadBanIndex();
    check('índice em memória tem o uuid', idx.uuids.has('uuid-gsw'), true);
    check('índice em memória tem os discords', idx.discordIds.has('discord-2'), true);

    check('remover por discord apaga o registro', await B2.removeBan({ discordId: 'discord-1' }), 1);
    check('depois de remover, não está banido', await B2.isBanned({ uuid: 'uuid-gsw' }), false);

    // ------------------------------------------------ Season e off-season
    section('11. Season do jogo e off-season');
    const WS = await import('../src/services/wynnSeason.js');
    const S = await import('../src/services/seasons.js');

    const live = await WS.currentWynnSeason();
    check('detectou a season do jogo', typeof live?.number, 'number');
    check('id bate com o estado', live.id, live.active ? `S${live.number}` : `OFF-${live.number}`);
    check('id de off-season', WS.seasonIdFor({ number: 31, active: false }), 'OFF-31');
    check('id de season ativa', WS.seasonIdFor({ number: 31, active: true }), 'S31');

    // Modo 'wynn' (padrão) troca a season sozinho e fecha a anterior.
    const opened = await S.ensureActiveSeason();
    check('bot passa a contabilizar na season do jogo', opened.seasonId, live.id);
    check('marca se é off-season', opened.offSeason, !live.active);
    const oldS1 = await collections.seasons().findOne({ seasonId: 'S1' });
    check('season anterior foi encerrada', oldS1.active === false && !!oldS1.endAt, true);

    const again = await S.ensureActiveSeason();
    check('chamar de novo é idempotente', again.seasonId, live.id);
    check('não duplicou a season', await collections.seasons().countDocuments({ seasonId: live.id }), 1);

    // Pontos de season e de off-season vão para baldes distintos.
    const C = { uuid: 'uuid-c', username: 'Carol' };
    await P.recordEvent({ ...C, type: 'war', qty: 1 }); // cai na season atual
    await S.startSeason('OFF-99'); // simula a virada para off-season
    await P.recordEvent({ ...C, type: 'war', qty: 4 }); // cai no off-season
    await P.recomputePoints();

    const bucket = async (id) => (await collections.seasonParticipation().findOne({ seasonId: id, uuid: 'uuid-c' }))?.points;
    check('1 guerra na season do jogo = 20 pts', await bucket(live.id), 20);
    check('4 guerras no off-season = 80 pts', await bucket('OFF-99'), 80);
    check('acumulado soma os dois = 100 pts', await pts('uuid-c'), 100);

    // -------------------------------------------------- Empréstimo vencido
    section('12. Empréstimo vencido continua ativo e pode ser quitado');
    const { ACTIVE_STATUSES } = await import('../src/discord/commands/loan.js');
    const loans = collections.loans();
    const ontem = new Date(Date.now() - 86_400_000);
    const { insertedId } = await loans.insertOne({
      borrowerDiscordId: 'discord-x',
      type: 'item',
      itemDesc: 'Set de XP',
      dueAt: ontem,
      status: 'open',
      overdueReminders: 0,
      lastReminderAt: null,
    });

    // É isto que o job de lembretes faz.
    await loans.updateMany({ status: 'open', dueAt: { $lt: new Date() } }, { $set: { status: 'overdue' } });
    check('venceu, virou overdue', (await loans.findOne({ _id: insertedId })).status, 'overdue');

    const ativos = await loans.find({ status: { $in: ACTIVE_STATUSES } }).toArray();
    check('atrasado ainda aparece no /loan list', ativos.length, 1);

    const quitado = await loans.updateOne(
      { _id: insertedId, status: { $in: ACTIVE_STATUSES } },
      { $set: { status: 'repaid' } },
    );
    check('atrasado PODE ser marcado como pago', quitado.matchedCount, 1);
    check('estado final', (await loans.findOne({ _id: insertedId })).status, 'repaid');

    // Regressão: o filtro antigo (só 'open') não pegava o atrasado.
    await loans.updateOne({ _id: insertedId }, { $set: { status: 'overdue' } });
    const filtroAntigo = await loans.updateOne({ _id: insertedId, status: 'open' }, { $set: { status: 'repaid' } });
    check('o filtro antigo falhava (bug reproduzido)', filtroAntigo.matchedCount, 0);

    // Alterar o prazo ressuscita um atrasado e zera o ciclo de cobrança.
    await loans.updateOne({ _id: insertedId }, { $set: { status: 'overdue', overdueReminders: 4, dueSoonNotified: true } });
    const novo = await loans.findOneAndUpdate(
      { _id: insertedId, status: { $in: ACTIVE_STATUSES } },
      { $set: { dueAt: new Date(Date.now() + 7 * 86_400_000), status: 'open', dueSoonNotified: false, overdueReminders: 0, lastReminderAt: null } },
      { returnDocument: 'after' },
    );
    check('prazo novo devolve o empréstimo para "open"', novo.status, 'open');
    check('e zera as cobranças de atraso', novo.overdueReminders, 0);
    check('e o aviso de vencimento pode disparar de novo', novo.dueSoonNotified, false);
    check('vence no futuro', novo.dueAt > new Date(), true);

    // Confirmação de recebimento é do devedor, e só acontece uma vez.
    const conf = await loans.findOneAndUpdate(
      { _id: insertedId, confirmedAt: null },
      { $set: { confirmedAt: new Date() } },
      { returnDocument: 'after' },
    );
    check('devedor confirma o recebimento', !!conf.confirmedAt, true);
    const reconf = await loans.updateOne({ _id: insertedId, confirmedAt: null }, { $set: { confirmedAt: new Date() } });
    check('não dá para confirmar duas vezes', reconf.matchedCount, 0);
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
