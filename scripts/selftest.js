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

  // ------------------------------------------------- Comandos construíveis
  //
  // Esta seção vem PRIMEIRO porque a falha que ela pega mata o bot no boot,
  // antes do login: os builders são avaliados no import do módulo, e
  // `addChoices` rejeita mais de 25 opções ali mesmo. Foi assim que PARAM_KEYS
  // passar de 25 derrubou tudo, com o painel de status parado como único
  // sintoma visível. O import abaixo é metade do teste — se algum comando
  // estourar um limite do Discord, ele nem chega no primeiro check.
  section('0. Todo comando cabe nos limites do Discord');
  const { COMMANDS } = await import('../src/discord/commandLoader.js');
  const estouros = [];
  for (const c of COMMANDS) {
    const opcoes = [...(c.data.options ?? []), ...(c.data.options ?? []).flatMap((o) => o.options ?? [])];
    for (const o of opcoes) {
      if ((o.choices?.length ?? 0) > 25) estouros.push(`/${c.data.name} ${o.name}: ${o.choices.length} choices`);
    }
  }
  check('nenhuma opção passa de 25 choices', estouros, []);
  check('todos os comandos foram construídos', COMMANDS.length > 0, true);

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

  section('6b. Check-in: ninguém entra na lista de kick sem ter sido perguntado');
  const { inactivityStatus } = await import('../src/services/inactivityCheck.js');
  const cp = { ...ip, inactivityCheckHours: 24, inactivityReturnDays: 3 };
  const agora = Date.now();
  const hMs = 3_600_000;
  const off = (d) => new Date(agora - d * 86_400_000);

  // Todos abaixo estão offline além do limite; o que muda é a resposta ao check-in.
  const membros = [
    { uuid: 'u-mudo', username: 'Mudo', lastJoin: off(30), online: false },
    { uuid: 'u-novo', username: 'RecemPerguntado', lastJoin: off(20), online: false },
    { uuid: 'u-saiu', username: 'Desistiu', lastJoin: off(15), online: false },
    { uuid: 'u-fica', username: 'QuerFicar', lastJoin: off(40), online: false },
    { uuid: 'u-furou', username: 'PrometeuENaoLogou', lastJoin: off(25), online: false },
    { uuid: 'u-semdm', username: 'SemDM', lastJoin: off(12), online: false },
    { uuid: 'u-virgem', username: 'AindaNaoPerguntado', lastJoin: off(9), online: false },
    { uuid: 'u-ativo', username: 'Ativo', lastJoin: off(1), online: false },
  ];
  const semPontos = new Map();
  const registros = [
    { uuid: 'u-mudo', status: 'pending', sentAt: new Date(agora - 25 * hMs) },
    { uuid: 'u-novo', status: 'pending', sentAt: new Date(agora - 2 * hMs) },
    { uuid: 'u-saiu', status: 'quit', sentAt: new Date(agora - 2 * hMs) },
    // Disse que voltaria há 2h: dentro dos 3 dias para logar.
    { uuid: 'u-fica', status: 'stay', sentAt: new Date(agora - 3 * hMs), respondedAt: new Date(agora - 2 * hMs) },
    // Disse o mesmo há 4 dias e não logou (senão não estaria expulsável).
    { uuid: 'u-furou', status: 'stay', sentAt: new Date(agora - 100 * hMs), respondedAt: new Date(agora - 96 * hMs) },
    { uuid: 'u-semdm', status: 'unreachable', sentAt: new Date(agora - 2 * hMs) },
    // Voltou a jogar depois de perguntado: o registro sobrou, mas não vale nada.
    { uuid: 'u-ativo', status: 'pending', sentAt: new Date(agora - 99 * hMs) },
  ];
  const st = inactivityStatus(membros, semPontos, cp, registros, agora);
  const nomes = st.kick.map((k) => k.username);

  check('quem passou das 24h sem responder entra', nomes.includes('Mudo'), true);
  check('quem disse que perdeu o interesse entra', nomes.includes('Desistiu'), true);
  check('quem não tem como receber DM entra', nomes.includes('SemDM'), true);
  check('quem prometeu voltar e não logou em 3 dias entra', nomes.includes('PrometeuENaoLogou'), true);
  check('quem ainda está no prazo de resposta NÃO entra', nomes.includes('RecemPerguntado'), false);
  check('quem prometeu voltar e ainda tem prazo NÃO entra', nomes.includes('QuerFicar'), false);
  check('quem nunca foi perguntado NÃO entra', nomes.includes('AindaNaoPerguntado'), false);
  check('quem voltou a jogar NÃO entra', nomes.includes('Ativo'), false);
  check('lista sai do mais inativo para o menos', nomes, ['Mudo', 'PrometeuENaoLogou', 'Desistiu', 'SemDM']);
  check('o motivo acompanha cada nick', st.kick.map((k) => k.reason), ['não respondeu', 'disse que voltaria e não logou', 'sem interesse', 'não recebe DM']);
  check('os dois prazos aparecem como "aguardando"', st.waiting.map((w) => w.username), ['RecemPerguntado', 'QuerFicar']);
  check('e a staff vê o que está esperando de cada um', st.waiting.map((w) => w.note), ['responde até', 'precisa logar até']);

  // O prazo dos 3 dias corre da RESPOSTA, não do envio da DM.
  const respostaVelha = registros.map((c) => (c.uuid === 'u-fica' ? { ...c, sentAt: new Date(agora - 200 * hMs) } : c));
  check('DM antiga + resposta recente continua protegido', inactivityStatus(membros, semPontos, cp, respostaVelha, agora).kick.map((k) => k.username).includes('QuerFicar'), false);

  // Logar é o que reseta o contador: com lastJoin renovado, o membro deixa de
  // ser expulsável e some da lista, mesmo com o prazo dos 3 dias vencido.
  const logou = membros.map((m) => (m.uuid === 'u-furou' ? { ...m, lastJoin: off(1) } : m));
  check('logar dentro do prazo tira da lista', inactivityStatus(logou, semPontos, cp, registros, agora).kick.map((k) => k.username).includes('PrometeuENaoLogou'), false);

  // A margem comprada com pontos vence o check-in: sem estourar o limite, nem a
  // resposta "perdi o interesse" coloca alguém na lista.
  const ricos = new Map([['u-saiu', 10_000]]);
  check('contribuição protege mesmo quem respondeu que saiu', inactivityStatus(membros, ricos, cp, registros, agora).kick.map((k) => k.username).includes('Desistiu'), false);

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
    // A visão virou uma FILEIRA DE BOTÕES (o select saiu): o botão da visão
    // ativa fica em Primary (style 1) e os demais em Secondary (style 2).
    const botoes = (p) => p.components[0].toJSON().components;
    const ativo = (p) => botoes(p).find((b) => b.style === 1)?.custom_id;
    const linha = botoes(painel);

    check('painel mostra pontos por padrão', painel.embeds[0].title.includes('Pontos'), true);
    check('a fileira tem pontos + todas as categorias', linha.length, 1 + Object.keys(P.CATEGORIES).length);
    check('cabe no limite de 5 botões por fileira', linha.length <= 5, true);
    check('rótulos ≤ 80 chars', linha.every((b) => (b.label || '').length <= 80), true);
    check('nunca mais de 15 linhas', painel.embeds[0].description.split('\n').length <= 15, true);
    // "Meus pontos" fica na fileira de escopo, DEPOIS dos botões de escopo.
    const escopo = painel.components[1].toJSON().components;
    check('botão Meus pontos presente', escopo.some((b) => b.custom_id === LP.ME_ID), true);
    check('botão "pontos" marcado como ativo', ativo(painel), `${LP.VIEW_PREFIX}pontos`);

    // A visão do painel é PÚBLICA: precisa sobreviver ao job que o republica.
    await collections.watcherState().updateOne({ _id: 'leaderboardPanel' }, { $set: { view: 'xp' } }, { upsert: true });
    const emXp = await LP.buildLeaderboardPanel();
    check('painel republicado respeita a visão salva', emXp.embeds[0].title.includes('XP'), true);
    check('o botão da visão salva fica ativo', ativo(emXp), `${LP.VIEW_PREFIX}xp`);
    check('e só um botão fica ativo por vez', botoes(emXp).filter((b) => b.style === 1).length, 1);

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

    check('remover por discord isenta o registro', await B2.removeBan({ discordId: 'discord-1' }), 1);
    check('depois de remover, não está banido', await B2.isBanned({ uuid: 'uuid-gsw' }), false);

    // A isenção existe justamente para sobreviver ao roleSync, que a cada ciclo
    // reencontra a pessoa na GsW e tentaria bani-la de novo.
    check('o registro virou isenção, não sumiu', !!(await B2.findExemption({ uuid: 'uuid-gsw' })), true);
    check('não conta como banimento ativo', await B2.countBans(), 0);
    check('conta como isenção', await B2.countExemptions(), 1);

    const reban = await B2.recordBan({ uuid: 'uuid-gsw', discordId: 'discord-1', reason: B2.BAN_REASON_BLACKLIST_GUILD });
    check('regra automática é recusada pela isenção', reban, false);
    check('e a pessoa segue não-banida', await B2.isBanned({ uuid: 'uuid-gsw' }), false);

    // A isenção herda a teia: conta nova com o mesmo Discord também é isenta.
    check('conta nova, mesmo Discord => isento', await B2.isExempt({ uuid: 'uuid-outro', discordId: 'discord-1' }), true);

    const idx2 = await B2.loadBanIndex();
    check('índice separa isento de banido', [idx2.uuids.size, idx2.exemptUuids.has('uuid-gsw')], [0, true]);
    check('exemptInIndex acha pelo discord', B2.exemptInIndex(idx2, { discordId: 'discord-2' }), true);

    // Staff rebanindo à mão vence a isenção.
    check('ban explícito da staff derruba a isenção', await B2.recordBan({ uuid: 'uuid-gsw', reason: 'reincidiu', by: 'staff-1', override: true }), true);
    check('voltou a estar banido', await B2.isBanned({ uuid: 'uuid-gsw' }), true);
    check('não sobrou isenção', await B2.countExemptions(), 0);
    check('motivo novo prevalece', (await B2.findBan({ uuid: 'uuid-gsw' })).reason, 'reincidiu');

    // ---------------------------------------------------- Advertências
    section('10b. Advertências acumulam, expiram e escalam para ban');
    const W = await import('../src/services/warns.js');
    const GID = process.env.DISCORD_GUILD_ID;

    // Corte de expiração é função pura: dá para conferir sem tocar no banco.
    check('expiração desligada com 0 dias', W.expiryCutoff(0), null);
    check('90 dias vira uma data no passado', W.expiryCutoff(90) < new Date(), true);

    const alvo = { uuid: 'uuid-warn', username: 'Advertido', discordId: 'discord-w1' };
    const w1 = await W.recordWarn(GID, { ...alvo, reason: 'flood', by: 'staff-1' });
    check('primeira advertência conta 1', w1.active, 1);
    check('limiar vem da config', w1.threshold, 3);
    check('id curto para o /warn remove', w1.warn.warnId.length, 8);
    check('ainda não bane', (await W.escalate(GID, { ...alvo, ...w1 })).banned, false);

    // A teia de identidade vale aqui também: mesmo Discord, conta nova.
    const w2 = await W.recordWarn(GID, { uuid: 'uuid-warn-2', discordId: 'discord-w1', reason: 'spam', by: 'staff-1' });
    check('conta nova, mesmo Discord => acumula', w2.active, 2);

    const w3 = await W.recordWarn(GID, { ...alvo, reason: 'desrespeito', by: 'staff-1' });
    check('terceira atinge o limiar', w3.active, 3);
    const esc = await W.escalate(GID, { ...alvo, ...w3 });
    check('escalou para ban', esc.banned, true);
    check('e o ban existe de verdade', await B2.isBanned({ uuid: 'uuid-warn' }), true);

    // Sem uuid não dá para banir: o ban é indexado por conta do jogo.
    const semConta = { uuid: null, discordId: 'discord-w9' };
    const w4 = await W.recordWarn(GID, { ...semConta, reason: 'a', by: 'staff-1' });
    check('escalação sem uuid é recusada', (await W.escalate(GID, { ...semConta, active: 99, threshold: 3 })).reason, 'noUuid');
    check('mas a advertência foi registrada', w4.active, 1);

    // Perdão mantém o registro e tira da contagem.
    check('perdoar devolve true', await W.removeWarn(w1.warn.warnId, 'staff-2', 'apelou'), true);
    check('perdoar de novo devolve false', await W.removeWarn(w1.warn.warnId, 'staff-2'), false);
    check('ativas caem para 2', await W.countActiveWarns(GID, alvo), 2);
    const hist = await W.warnHistory(GID, alvo);
    check('histórico mantém a perdoada', hist.length, 3);
    check('e a marca como não-ativa', hist.find((w) => w.warnId === w1.warn.warnId).active, false);

    check('clear perdoa as restantes', await W.clearWarns(GID, alvo, 'staff-2'), 2);
    check('sobra zero ativa', await W.countActiveWarns(GID, alvo), 0);
    check('histórico continua inteiro', (await W.warnHistory(GID, alvo)).length, 3);

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

    // ------------------------------------ Linha de base do primeiro snapshot
    section('12. Primeira apuração dá linha de base aos veteranos');
    const { takeSnapshots } = await import('../src/services/progress.js');

    await collections.pointsEvents().deleteMany({});
    await collections.progressSnapshots().deleteMany({});
    await collections.guildStats().deleteMany({});
    await setParam(gid, 'pointsWeights', base);

    await takeSnapshots(); // primeiro: baseline
    const baseEv = await collections.pointsEvents().find({ 'meta.baseline': true }).toArray();
    const tipos = [...new Set(baseEv.map((e) => e.type))].sort();
    check('baseline só cria contribuição e guild raid', tipos, ['contribution', 'guildRaid']);
    check('nenhuma guerra na linha de base', baseEv.filter((e) => e.type === 'war').length, 0);

    await P.recomputePoints();
    const comPontos = await collections.guildStats().countDocuments({ points: { $gt: 0 } });
    check('membros já entram com pontos', comPontos > 0, true);

    // A linha de base é o passado INTEIRO do membro na guilda. Ela existe para o
    // placar acumulado não zerar um veterano — creditá-la à season em que o
    // membro apareceu daria a ele um saldo de season que ele não fez.
    const { getActiveSeason } = await import('../src/services/seasons.js');
    const ativa = (await getActiveSeason())?.seasonId ?? null;
    const vazouParaSeason = await collections.seasonParticipation().countDocuments({
      seasonId: ativa,
      $or: [
        { points: { $gt: 0 } },
        { guildRaidsDelta: { $gt: 0 } },
        { contributedDelta: { $gt: 0 } },
      ],
    });
    check('linha de base não entra na season ativa', vazouParaSeason, 0);

    const topo = await collections.guildStats().find({}).sort({ points: -1 }).limit(1).next();
    console.log(`       (topo: ${topo.username} = ${topo.points} pts de ${(topo.contributed / 1e6).toFixed(0)}M de XP)`);
    check('pontos do topo batem com XP + guild raids', topo.points, Math.round(topo.contributed / 1e6) + topo.guildRaids * 10);

    // Rodar de novo não pode duplicar: o segundo snapshot só tem deltas (zero).
    await takeSnapshots();
    await P.recomputePoints();
    const topo2 = await collections.guildStats().findOne({ uuid: topo.uuid });
    check('segunda apuração não duplica a linha de base', topo2.points, topo.points);
    check('e não gera novo evento de baseline', await collections.pointsEvents().countDocuments({ 'meta.baseline': true }), baseEv.length);

    // -------------------------------------------------- Empréstimo vencido
    section('13. Empréstimo vencido continua ativo e pode ser quitado');
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

    // ------------------------------------------------ Evento de competição
    section('14. Data de início: o que a staff digita, no fuso de Brasília');
    const E = await import('../src/services/events.js');
    // Sem canal e com um client oco: painel e anúncio saem de cena, sobra a apuração.
    const semDiscord = { channels: { fetch: async () => null } };
    const h = (n) => new Date(Date.now() - n * 3_600_000);
    const ev = (uuid, username, type, qty, at, meta = null) => ({ uuid, username, type, qty, meta, seasonId: 'S1', at });

    // Brasília é UTC−3 o ano inteiro (o horário de verão acabou em 2019), então
    // 00:00 do dia 29 é 03:00 UTC do dia 29.
    const jul = new Date('2026-07-27T12:00:00Z');
    const iso = (d) => d?.toISOString();
    check('29/07 00:00 vira 03:00 UTC', iso(E.parseStart('29/07 00:00', jul)), '2026-07-29T03:00:00.000Z');
    check('com ano explícito dá no mesmo', iso(E.parseStart('29/07/2026 00:00', jul)), '2026-07-29T03:00:00.000Z');
    check('formato ISO também vale', iso(E.parseStart('2026-07-29 00:00', jul)), '2026-07-29T03:00:00.000Z');
    check('sem hora, meia-noite', iso(E.parseStart('29/07', jul)), '2026-07-29T03:00:00.000Z');
    check('hora do meio do dia', iso(E.parseStart('29/07 18:30', jul)), '2026-07-29T21:30:00.000Z');
    // Sem ano, uma data que já passou neste ano só pode ser a do ano que vem.
    check('05/01 em julho é o ano que vem', iso(E.parseStart('05/01', jul)), '2027-01-05T03:00:00.000Z');
    check('data impossível é recusada', E.parseStart('31/02 00:00', jul), null);
    check('hora impossível é recusada', E.parseStart('29/07 25:00', jul), null);
    check('texto solto é recusado', E.parseStart('semana que vem', jul), null);

    section('15. Guild raid: a tabela do evento anda no gatilho, não no dia seguinte');
    // Um evento que só abre daqui a uma hora não pode receber crédito nenhum.
    const agendado = await E.createEvent({
      name: 'Corrida Agendada',
      metricKey: 'guildraid',
      days: 7,
      prize: '5 LE',
      startAt: new Date(Date.now() + 3_600_000),
      guildDiscordId: gid,
      createdBy: 'staff',
      channelId: null,
    });
    check('evento agendado ainda não começou', E.hasStarted(agendado), false);
    check('raid antes da abertura não é creditada', await E.creditGuildRaid({ uuid: 'gr-ana', username: 'Ana' }), 0);
    check('e a tabela segue vazia', await E.scoreCount(agendado.eventId), 0);

    // Agora um evento valendo. Guild raid é métrica de gatilho: `countFrom` é o
    // próprio início, sem precisar de corte na contagem diária.
    const corrida = await E.createEvent({
      name: 'Corrida de Raids',
      metricKey: 'guildraid',
      days: 14,
      prize: '3 LE',
      podium: 2,
      points: 100,
      guildDiscordId: gid,
      createdBy: 'staff',
      channelId: null,
    });
    check('métrica de gatilho não espera corte', !!corrida.countFrom, true);
    check('e já está valendo', E.hasStarted(corrida), true);

    // O livro-razão do dia seguinte não pode ser lido por esta métrica: se fosse,
    // estes lançamentos entrariam duas vezes.
    await collections.pointsEvents().insertOne(ev('gr-ana', 'Ana', 'guildRaid', 99, new Date()));

    const t0 = new Date();
    const emT = (min) => new Date(t0.getTime() + min * 60_000);
    // Ana e Beto terminam a mesma raid (mesmo grupo), depois Ana faz mais duas.
    await E.creditGuildRaid({ uuid: 'gr-ana', username: 'Ana', at: emT(1) });
    await E.creditGuildRaid({ uuid: 'gr-beto', username: 'Beto', at: emT(1) });
    await E.creditGuildRaid({ uuid: 'gr-ana', username: 'Ana', at: emT(5) });
    await E.creditGuildRaid({ uuid: 'gr-ana', username: 'Ana', at: emT(9) });
    // Caio empata com Beto em 1, mas chegou depois.
    await E.creditGuildRaid({ uuid: 'gr-caio', username: 'Caio', at: emT(30) });

    const tabela = await E.scoreboard(corrida.eventId);
    check('cada raid vale 1 para cada membro do grupo', tabela.map((r) => `${r.username}:${r.value}`), ['Ana:3', 'Beto:1', 'Caio:1']);
    check('o livro-razão não entra em métrica de gatilho', tabela.every((r) => r.value < 99), true);
    check('empate vai para quem chegou primeiro', [tabela[1].username, tabela[2].username], ['Beto', 'Caio']);
    check('a posição é gravada na tabela', tabela.map((r) => r.rank), [1, 2, 3]);
    check('e o instante da última raid também', (await E.memberScore(corrida.eventId, 'gr-ana')).reachedAt.getTime(), emT(9).getTime());

    // Uma raid depois do prazo não conta: o evento já fechou a janela.
    await collections.events().updateOne({ eventId: corrida.eventId }, { $set: { endAt: new Date(Date.now() - 1000) } });
    check('raid depois do prazo não é creditada', await E.creditGuildRaid({ uuid: 'gr-zeta', username: 'Zeta' }), 0);
    await collections.events().updateOne({ eventId: corrida.eventId }, { $set: { endAt: new Date(Date.now() + 86_400_000) } });

    check('1º leva o prêmio cheio', E.podiumPoints(100, 1), 100);
    check('2º leva metade', E.podiumPoints(100, 2), 50);
    check('3º leva metade da metade', E.podiumPoints(100, 3), 25);
    check('sem prêmio em pontos, ninguém recebe', E.podiumPoints(0, 1), 0);

    const { winners } = await E.endEvent(semDiscord, await E.getEvent(corrida.eventId));
    check('só o pódio (top 2) ganha', winners.map((w) => w.username), ['Ana', 'Beto']);
    check('e cada um leva os pontos da sua posição', winners.map((w) => w.points), [100, 50]);
    const manual = await collections.pointsEvents().findOne({ uuid: 'gr-ana', type: 'manual' });
    check('o prêmio entra no livro-razão', manual?.qty, 100);
    check('com o motivo registrado', manual?.meta?.reason?.includes('Corrida de Raids'), true);
    check('evento marcado como encerrado', (await E.getEvent(corrida.eventId)).status, 'ended');

    // Encerrar de novo não pode premiar de novo.
    const dobrado = await E.endEvent(semDiscord, await E.getEvent(corrida.eventId));
    check('encerrar duas vezes não repremia', dobrado.winners.length, 2);
    check('e não gera segundo prêmio', await collections.pointsEvents().countDocuments({ uuid: 'gr-ana', type: 'manual' }), 1);
    check('encerrado, o gatilho não credita mais', await E.creditGuildRaid({ uuid: 'gr-ana', username: 'Ana' }), 0);

    section('16. Guerra e XP: janela do livro-razão, sem nada de antes');
    // Estas métricas não têm gatilho — só existem como delta da contagem diária.
    const inicio = h(24);
    const depois = (n) => new Date(inicio.getTime() + n * 3_600_000);

    await collections.pointsEvents().insertMany([
      // Tudo o que veio ANTES do evento é passado: não conta, nem um segundo antes.
      ev('ev-ana', 'Ana', 'war', 50, new Date(inicio.getTime() - 86_400_000)),
      ev('ev-beto', 'Beto', 'war', 30, new Date(inicio.getTime() - 1000)),
      // O corte é o próprio instante da abertura: o lançamento que o fecha é passado.
      ev('ev-caio', 'Caio', 'war', 7, inicio),
      // Depois. Ana e Beto empatam em 5; Beto chegou aos 5 antes.
      ev('ev-ana', 'Ana', 'war', 2, depois(3)),
      ev('ev-ana', 'Ana', 'war', 3, depois(14)),
      ev('ev-beto', 'Beto', 'war', 5, depois(6)),
      ev('ev-caio', 'Caio', 'war', 9, depois(19)),
      // Outra métrica: não entra num evento de guerra.
      ev('ev-ana', 'Ana', 'contribution', 100_000_000, depois(19)),
      // Linha de base de quem entrou no meio do evento: a vida inteira dele.
      ev('ev-novato', 'Novato', 'war', 999, depois(22), { baseline: true }),
      // Empate TOTAL: mesma quantidade no mesmo instante (o caso comum, já que a
      // contagem é diária e carimba todo mundo com a mesma hora).
      ev('ev-zeta', 'Zeta', 'war', 1, depois(20)),
      ev('ev-alfa', 'Alfa', 'war', 1, depois(20)),
    ]);

    const guerras = {
      eventId: 'guerra-total',
      name: 'Guerra Total',
      metric: 'guerra',
      prize: 'Cargo de Campeão',
      podium: 2,
      points: 0,
      startAt: inicio,
      countFrom: inicio,
      endAt: new Date(Date.now() + 7 * 86_400_000),
      status: 'active',
      guildDiscordId: gid,
      channelId: null,
      messageId: null,
      winners: [],
    };
    await collections.events().insertOne(guerras);

    const tab = await E.refreshScores(guerras);
    check('ranking do evento', tab.slice(0, 3).map((r) => `${r.username}:${r.value}`), ['Caio:9', 'Beto:5', 'Ana:5']);
    check('o que veio antes do evento não conta', tab.find((r) => r.username === 'Ana').value, 5);
    check('nem o que veio 1 segundo antes', tab.find((r) => r.username === 'Beto').value, 5);
    check('nem o lançamento que fecha o passado', tab.find((r) => r.username === 'Caio').value, 9);
    check('a linha de base do novato fica de fora', tab.some((r) => r.username === 'Novato'), false);
    check('XP não entra num evento de guerra', tab.every((r) => r.value < 100), true);
    // Ana só completou as 5 em depois(14); Beto já estava com 5 em depois(6).
    check('empate vai para quem chegou ao número primeiro', tab[1].username, 'Beto');
    check('e o retardatário fica atrás mesmo empatado', tab[2].username, 'Ana');
    check('o instante da chegada fica registrado', tab[1].reachedAt.getTime(), depois(6).getTime());
    // Empate total cai no nome: o critério não importa, mas TEM que ser sempre o
    // mesmo — o painel reapura sozinho e não pode trocar as posições.
    check('empate total desempata de forma estável', [tab[3].username, tab[4].username], ['Alfa', 'Zeta']);

    const secundaria = await E.scoreboard('guerra-total');
    check('a tabela secundária foi materializada', secundaria.length, 5);
    check('e sai na mesma ordem da apuração', secundaria.map((r) => r.username), tab.map((r) => r.username));
    check('e guarda a posição', (await E.memberScore('guerra-total', 'ev-caio')).rank, 1);

    // Reapurar não pode duplicar nem inflar a tabela.
    const reapurada = await E.refreshScores(guerras);
    check('reapurar não duplica linhas', await E.scoreCount('guerra-total'), 5);
    check('nem embaralha o ranking', reapurada.map((r) => r.username), tab.map((r) => r.username));
    check('nem muda o valor', (await E.memberScore('guerra-total', 'ev-caio')).value, 9);

    // O corte da abertura é `countFrom`, não `startAt`: é ele que a contagem
    // diária fixa quando o evento agendado abre.
    await collections.events().updateOne({ eventId: 'guerra-total' }, { $set: { countFrom: depois(15) } });
    const cortada = await E.refreshScores(await E.getEvent('guerra-total'));
    check('mover o corte reescreve a tabela', cortada.map((r) => `${r.username}:${r.value}`), ['Caio:9', 'Alfa:1', 'Zeta:1']);
    check('e quem ficou sem lançamento sai da tabela', await E.scoreCount('guerra-total'), 3);

    // ------------------------------------------------------------ Sorteio
    section('17. Sorteio: uma inscrição por pessoa e vencedores distintos');
    const G = await import('../src/services/giveaways.js');

    const aberto = await G.createGiveaway({
      prize: 'Mythic',
      hours: 48,
      winnersCount: 2,
      guildDiscordId: gid,
      createdBy: 'staff',
      channelId: null,
    });
    check('id do sorteio sai do prêmio', aberto.giveawayId, 'mythic');

    const entrou = await G.toggleEntry(aberto, 'discord-1');
    check('entrou no sorteio', entrou.status, 'joined');
    check('contador subiu', entrou.total, 1);
    const denovo = await G.toggleEntry(aberto, 'discord-1');
    check('clicar de novo sai', denovo.status, 'left');
    check('contador desceu', denovo.total, 0);

    for (const id of ['discord-1', 'discord-2', 'discord-3', 'discord-4', 'discord-5']) {
      await G.toggleEntry(aberto, id);
    }
    check('cinco inscritos', await G.entryCount('mythic'), 5);

    const restrito = await G.createGiveaway({
      prize: 'Cargo VIP',
      hours: 1,
      requirement: 'pontos',
      minPoints: 999_999,
      guildDiscordId: gid,
      createdBy: 'staff',
      channelId: null,
    });
    const barrado = await G.toggleEntry(restrito, 'discord-1');
    check('sem vínculo, o requisito barra', barrado.status, 'blocked');
    check('e explica o porquê', barrado.reason.includes('/link'), true);

    const sorteio = await G.endGiveaway({}, aberto);
    check('sorteou o número de vagas', sorteio.winners.length, 2);
    check('vencedores distintos', new Set(sorteio.winners.map((w) => w.discordId)).size, 2);
    check('e saíram dos inscritos', sorteio.winners.every((w) => w.discordId.startsWith('discord-')), true);
    check('sorteio fechado', (await G.getGiveaway('mythic')).status, 'ended');

    const resorteio = await G.endGiveaway({}, await G.getGiveaway('mythic'));
    check('sortear duas vezes devolve o mesmo resultado', resorteio.winners.map((w) => w.discordId).sort(), sorteio.winners.map((w) => w.discordId).sort());

    const reroll = await G.rerollGiveaway({}, await G.getGiveaway('mythic'));
    check('o reroll não repete quem já ganhou', reroll.winners.every((w) => !sorteio.winners.some((v) => v.discordId === w.discordId)), true);
    check('e sorteia entre os 3 que sobraram', reroll.winners.length, 2);
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
