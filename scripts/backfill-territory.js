// Credita o PESO das capturas já registradas a quem guerreou na janela delas.
//
//   node scripts/backfill-territory.js --dry    # mostra o que faria
//   node scripts/backfill-territory.js          # grava e reapura
//
// Por que existe: entre 9/ago e a volta da ponderação, a captura era registro da
// guilda e não pontuava ninguém. As capturas ficaram gravadas (com o
// multiplicador da torre), mas nenhum evento de território foi para o
// livro-razão — toda guerra desse período valeu a base, sem o peso do
// território.
//
// A atribuição usa a MESMA função do caminho ao vivo (attributeCaptures), com os
// incrementos de contador vindos de `warAudit`, que grava por poll quem teve o
// contador subindo e em quanto.
//
// O LIMITE, e ele é duro: warAudit expira em 30 dias. Captura mais velha que
// isso não tem como saber quem guerreou, e fica sem crédito — o script conta
// quantas foram, em vez de inventar participante.
//
// Idempotente: o índice único (uuid, type, meta.captureId) recusa o segundo
// crédito da mesma captura, então rodar duas vezes não paga duas vezes.

import { loadEnv } from '../src/config/env.js';
import { connectMongo, closeMongo, collections } from '../src/db/mongo.js';
import { attributeCaptures, captureId } from '../src/services/territories.js';
import { recordEvent, recomputePoints, rebuildLeaderboards, eventPoints } from '../src/services/points.js';
import { getConfig } from '../src/config/guildConfig.js';
import { optional } from '../src/config/env.js';

const DRY = process.argv.includes('--dry');
const p = (s) => console.log(`${DRY ? '[dry] ' : ''}${s}`);

// A mesma janela do caminho ao vivo (ver services/watcher.js): o contador de
// guerra é cacheado pesado e o incremento aparece DEPOIS da captura, nunca muito
// antes.
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 45 * 60_000;

async function main() {
  loadEnv();
  await connectMongo();

  const params = (await getConfig(optional('DISCORD_GUILD_ID'))).params || {};

  const capturas = await collections
    .territoryCaptures()
    .find({ multiplier: { $gt: 1 } })
    .sort({ at: 1 })
    .toArray();

  // ---- Camada 1: auditoria por poll (60s), ultimos 30 dias ----
  const auditoria = await collections.warAudit().find({}).sort({ at: 1 }).toArray();
  const daAuditoria = auditoria.flatMap((a) =>
    (a.membros ?? []).map((m) => ({ uuid: m.uuid, username: m.username, at: new Date(a.at).getTime(), delta: m.delta })),
  );
  const inicioAuditoria = daAuditoria.length ? daAuditoria[0].at : Infinity;

  // ---- Camada 2: livro-razao, com a janela de cada apuracao ----
  //
  // A janela de um evento de guerra vai do snapshot ANTERIOR daquele membro ate
  // o instante do evento. Sem snapshot anterior (o primeiro dele), cai na
  // cadencia de uma hora, que e o intervalo do job de progresso.
  const guerras = await collections
    .pointsEvents()
    .find({ type: 'war', qty: { $gt: 0 } }, { projection: { uuid: 1, username: 1, qty: 1, at: 1 } })
    .sort({ at: 1 })
    .toArray();
  const snapshots = await collections
    .progressSnapshots()
    .find({}, { projection: { uuid: 1, takenAt: 1 } })
    .sort({ takenAt: 1 })
    .toArray();
  const porMembro = new Map();
  for (const snap of snapshots) {
    if (!porMembro.has(snap.uuid)) porMembro.set(snap.uuid, []);
    porMembro.get(snap.uuid).push(new Date(snap.takenAt).getTime());
  }
  const anterior = (uuid, at) => {
    const lista = porMembro.get(uuid) ?? [];
    let melhor = null;
    for (const t of lista) {
      if (t < at) melhor = t;
      else break;
    }
    return melhor ?? at - 60 * 60_000;
  };

  const doLivro = [];
  for (const g of guerras) {
    const at = new Date(g.at).getTime();
    // Onde a auditoria existe, ela manda: contar as duas fontes seria orcamento
    // dobrado para a mesma guerra.
    if (at >= inicioAuditoria) continue;
    doLivro.push({ uuid: g.uuid, username: g.username, delta: g.qty, from: anterior(g.uuid, at), to: at });
  }

  const incrementos = [...doLivro, ...daAuditoria];
  const maisAntigo = incrementos.length ? Math.min(...incrementos.map((i) => i.from ?? i.at)) : Infinity;
  const dia = (ms) => new Date(ms).toISOString().slice(0, 10);
  console.log(
    `${capturas.length} captura(s) com peso. Incrementos de contador: ` +
      `${daAuditoria.length} da auditoria${daAuditoria.length ? ` (desde ${dia(inicioAuditoria)})` : ''}, ` +
      `${doLivro.length} do livro-razao${doLivro.length ? ` (desde ${dia(maisAntigo)})` : ''}.`,
  );

  // Captura que já tem crédito não entra de novo (o índice recusaria, mas assim
  // o relatório do --dry não mente).
  const jaCreditadas = new Set(
    await collections.pointsEvents().distinct('meta.captureId', { type: 'territory' }),
  );

  const pendentes = [];
  let semDados = 0;
  for (const c of capturas) {
    const id = c.captureId ?? captureId(c.territory, c.at);
    if (jaCreditadas.has(id)) continue;
    if (new Date(c.at).getTime() < maisAntigo) {
      semDados += 1;
      continue;
    }
    pendentes.push({ captureId: id, at: new Date(c.at).getTime(), multiplier: c.multiplier, territory: c.territory });
  }

  if (semDados) {
    p(`${semDados} captura(s) anterior(es) a qualquer registro de guerra: sem como saber quem guerreou, ficam sem crédito.`);
  }
  if (!pendentes.length) {
    console.log('Nada a creditar.');
    await closeMongo();
    return;
  }

  const creditos = attributeCaptures(pendentes, incrementos, { beforeMs: BEFORE_MS, afterMs: AFTER_MS });

  // A season de cada crédito é a que estava ABERTA na hora da captura. Deixar o
  // padrão (season ativa) jogaria capturas de agosto no balde de hoje, e o
  // ranking de season passaria a mostrar guerra que não foi feita nela.
  const seasons = await collections.seasons().find({}).sort({ startAt: 1 }).toArray();
  const seasonDe = (at) =>
    seasons.find((s) => {
      const inicio = s.startAt ? new Date(s.startAt).getTime() : -Infinity;
      const fim = s.endAt ? new Date(s.endAt).getTime() : Infinity;
      return at >= inicio && at <= fim;
    })?.seasonId ?? null;
  const porPessoa = new Map();
  for (const cr of creditos) {
    const linha = porPessoa.get(cr.uuid) || { username: cr.username, capturas: 0, pontos: 0 };
    linha.capturas += 1;
    linha.pontos += eventPoints({ type: 'territory', qty: cr.multiplier }, params);
    porPessoa.set(cr.uuid, linha);
  }

  const semGuerreiro = pendentes.length - new Set(creditos.map((c) => c.captureId)).size;
  console.log(`${pendentes.length} captura(s) a creditar, ${creditos.length} crédito(s) para ${porPessoa.size} pessoa(s).`);
  if (semGuerreiro) console.log(`${semGuerreiro} sem nenhum incremento de contador na janela — ninguém a creditar.`);

  for (const [, linha] of [...porPessoa].sort((a, b) => b[1].pontos - a[1].pontos).slice(0, 15)) {
    console.log(`  ${linha.username}: ${linha.capturas} captura(s), +${Math.round(linha.pontos)} pts`);
  }

  if (DRY) {
    p('nada foi gravado.');
    await closeMongo();
    return;
  }

  let gravados = 0;
  for (const cr of creditos) {
    const novo = await recordEvent({
      uuid: cr.uuid,
      username: cr.username,
      type: 'territory',
      qty: cr.multiplier,
      meta: { captureId: cr.captureId, backfill: true },
      at: new Date(cr.at),
      seasonId: seasonDe(cr.at),
    });
    if (novo) gravados += 1;
  }
  console.log(`\n${gravados} crédito(s) gravado(s) no livro-razão.`);

  const { members } = await recomputePoints();
  await rebuildLeaderboards();
  console.log(`Pontos reapurados (${members} membro(s)) e leaderboards reconstruídos.`);
  console.log('Painel se reedita em até 5 min, ou rode /leaderboard atualizar.');

  await closeMongo();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
