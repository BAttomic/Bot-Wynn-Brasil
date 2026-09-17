import { collections } from '../db/mongo.js';
import { attributeCaptures, captureId } from './territories.js';
import { recordEvent, recomputePoints, eventPoints } from './points.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Credita o PESO das capturas já registradas a quem guerreou na janela delas.
//
// Roda no boot (ver src/index.js) e também à mão, pelo
// scripts/backfill-territory.js, que é só um relatório em volta daqui.
//
// Por que existe: entre 9/ago e a volta da ponderação, a captura era registro da
// guilda e não pontuava ninguém. As capturas ficaram gravadas COM o
// multiplicador, mas nenhum evento de território foi para o livro-razão — toda
// guerra desse período valeu a base seca, e era isso que o ranking mostrava
// (1.191 guerras × 10 = 11.910 pts, sem um único peso de território).
//
// Os incrementos de contador vêm de duas fontes, em ordem de precisão:
//
//   1. `warAudit` — por poll (60s), quem teve o contador subindo e em quanto.
//      Expira em 30 dias, então cobre só a janela recente.
//   2. livro-razão (`pointsEvents` type 'war') — permanente, mas a granularidade
//      é a da apuração: "N guerras entre o snapshot anterior e este". A janela
//      da marca passa a ser esse intervalo inteiro.
//
// A fonte 1 vence onde existe: contar as duas seria orçamento dobrado para a
// mesma guerra. A camada 2 é mais grosseira, e isso tem um efeito conhecido:
// numa hora com duas capturas e uma guerra só, a pessoa leva UMA — o orçamento
// continua valendo —, e a escolhida é a mais antiga.
//
// Idempotente pelo índice único (uuid, type, meta.captureId): a segunda rodada
// não paga de novo. Por isso pode ficar no boot sem trava de migração.

// A mesma janela do caminho ao vivo (ver services/watcher.js): o contador é
// cacheado pesado, então o incremento aparece DEPOIS da captura.
const BEFORE_MS = 5 * 60_000;
const AFTER_MS = 45 * 60_000;
const HORA_MS = 60 * 60_000;

/**
 * @param {{dry?: boolean}} [opts]
 * @returns {Promise<{pendentes: number, creditos: number, pessoas: number, semGuerreiro: number,
 *                    semDados: number, gravados: number, porPessoa: Array<object>}>}
 */
export async function backfillTerritoryCredits({ dry = false } = {}) {
  const vazio = { pendentes: 0, creditos: 0, pessoas: 0, semGuerreiro: 0, semDados: 0, gravados: 0, porPessoa: [] };

  // As duas consultas baratas primeiro: sem captura pendente, o boot não paga
  // pela varredura de guerras e snapshots.
  const capturas = await collections
    .territoryCaptures()
    .find({ multiplier: { $gt: 1 } }, { projection: { captureId: 1, territory: 1, multiplier: 1, defences: 1, at: 1 } })
    .sort({ at: 1 })
    .toArray();
  if (!capturas.length) return vazio;

  const jaCreditadas = new Set(await collections.pointsEvents().distinct('meta.captureId', { type: 'territory' }));
  const candidatas = capturas
    .map((c) => ({
      captureId: c.captureId ?? captureId(c.territory, c.at),
      at: new Date(c.at).getTime(),
      multiplier: c.multiplier,
      defences: c.defences ?? null,
      territory: c.territory,
    }))
    .filter((c) => !jaCreditadas.has(c.captureId));
  if (!candidatas.length) return vazio;

  // ---- Camada 1: auditoria por poll (60s), últimos 30 dias ----
  const auditoria = await collections
    .warAudit()
    .find({ membrosDelta: { $gt: 0 } }, { projection: { at: 1, membros: 1 } })
    .sort({ at: 1 })
    .toArray();
  const daAuditoria = auditoria.flatMap((a) =>
    (a.membros ?? []).map((m) => ({
      uuid: m.uuid,
      username: m.username,
      at: new Date(a.at).getTime(),
      delta: m.delta,
    })),
  );
  const inicioAuditoria = daAuditoria.length ? daAuditoria[0].at : Infinity;

  // ---- Camada 2: livro-razão, com a janela de cada apuração ----
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
  // Snapshot anterior daquele membro. Sem nenhum, cai na cadência de uma hora,
  // que é o intervalo do job de progresso.
  const anterior = (uuid, at) => {
    const lista = porMembro.get(uuid) ?? [];
    let melhor = null;
    for (const t of lista) {
      if (t < at) melhor = t;
      else break;
    }
    return melhor ?? at - HORA_MS;
  };

  const doLivro = [];
  for (const g of guerras) {
    const at = new Date(g.at).getTime();
    if (at >= inicioAuditoria) continue;
    doLivro.push({ uuid: g.uuid, username: g.username, delta: g.qty, from: anterior(g.uuid, at), to: at });
  }

  const incrementos = [...doLivro, ...daAuditoria];
  if (!incrementos.length) return { ...vazio, pendentes: candidatas.length, semDados: candidatas.length };

  // Captura anterior a QUALQUER registro de guerra não tem como ser atribuída.
  // Ela é contada, não chutada.
  const maisAntigo = Math.min(...incrementos.map((i) => i.from ?? i.at));
  const pendentes = candidatas.filter((c) => c.at >= maisAntigo);
  const semDados = candidatas.length - pendentes.length;
  if (!pendentes.length) return { ...vazio, semDados };

  const creditos = attributeCaptures(pendentes, incrementos, { beforeMs: BEFORE_MS, afterMs: AFTER_MS });

  // A season de cada crédito é a que estava ABERTA na hora da captura. O padrão
  // de recordEvent (season ativa) jogaria captura de agosto no balde de hoje.
  const seasons = await collections
    .seasons()
    .find({}, { projection: { seasonId: 1, startAt: 1, endAt: 1 } })
    .toArray();
  const seasonDe = (at) =>
    seasons.find((s) => {
      const inicio = s.startAt ? new Date(s.startAt).getTime() : -Infinity;
      const fim = s.endAt ? new Date(s.endAt).getTime() : Infinity;
      return at >= inicio && at <= fim;
    })?.seasonId ?? null;

  const params = (await getConfig(optional('DISCORD_GUILD_ID'))).params || {};
  const porPessoa = new Map();
  for (const cr of creditos) {
    const linha = porPessoa.get(cr.uuid) || { uuid: cr.uuid, username: cr.username, capturas: 0, pontos: 0 };
    linha.capturas += 1;
    linha.pontos += eventPoints({ type: 'territory', qty: cr.multiplier, meta: { defences: cr.defences } }, params);
    porPessoa.set(cr.uuid, linha);
  }

  const relatorio = {
    pendentes: pendentes.length,
    creditos: creditos.length,
    pessoas: porPessoa.size,
    semGuerreiro: pendentes.length - new Set(creditos.map((c) => c.captureId)).size,
    semDados,
    gravados: 0,
    porPessoa: [...porPessoa.values()].sort((a, b) => b.pontos - a.pontos),
  };
  if (dry || !creditos.length) return relatorio;

  for (const cr of creditos) {
    const novo = await recordEvent({
      uuid: cr.uuid,
      username: cr.username,
      type: 'territory',
      qty: cr.multiplier,
      meta: { captureId: cr.captureId, defences: cr.defences ?? null, backfill: true },
      at: new Date(cr.at),
      seasonId: seasonDe(cr.at),
    });
    if (novo) relatorio.gravados += 1;
  }

  if (relatorio.gravados) {
    await recomputePoints();
    log.info(
      `Peso de território reposto: ${relatorio.gravados} crédito(s) em ${relatorio.pendentes} captura(s), ` +
        `${relatorio.pessoas} pessoa(s).`,
    );
  }
  return relatorio;
}
