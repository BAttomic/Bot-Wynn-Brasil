import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from './guildData.js';
import { ensureActiveSeason } from './seasons.js';
import { recordEvent } from './points.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Progresso novo de um contador de VIDA, medido contra a MARCA D'ÁGUA — o maior
// valor já visto para aquele membro —, nunca contra o snapshot anterior.
//
// `globalData.wars`, `raids` e `currentGuildRaids` só podem subir. Mas a API do
// Wynncraft às vezes devolve o campo zerado ou parcial, e a série gravada
// desce. Comparando com o snapshot ANTERIOR, a recuperação depois da queda
// vira progresso novo: um contador que pisca 122 → 0 → 122 quatro vezes acumula
// 488. Foi exatamente o que aconteceu — o HunterAlas ficou com 488 guerras
// tendo 122 na vida inteira, 4,0x cravado, e a soma de todo mundo estourou em
// dezenas de milhares.
//
// Contra a marca d'água isso não acontece: a queda para 0 não credita nada
// (não é progresso), e a volta para 122 também não (a marca já é 122). Só um
// 123 credita, e credita 1. O ruído fica matematicamente impossível, em vez de
// filtrado por heurística de teto.
//
// Um dos lados sem número (campo novo, snapshot de versão antiga da API) conta
// zero: não dá para afirmar nada, e o próximo snapshot já compara dois valores
// bons. As alternativas ingênuas são piores — tratar o ausente como 0 credita a
// vida inteira, e deixar `undefined` propagar dá NaN, que envenena o `$inc`.
//
// @param {number} atual   valor de agora
// @param {number} marca   maior valor já visto
// @param {number} cap     teto por apuração; salto acima disso é dado ruim
function novoProgresso(atual, marca, cap) {
  const c = Number(atual);
  const m = Number(marca);
  if (!Number.isFinite(c) || !Number.isFinite(m)) return 0;
  const d = c - m;
  if (d <= 0) return 0;
  if (cap && d > cap) return 0;
  return d;
}

/**
 * Maior valor já visto, para a comparação nunca andar para trás.
 * @param {object} stats     documento de guildStats (marcas gravadas)
 * @param {object} snapshot  metrics do snapshot anterior
 * @param {string} campo     nome em metrics (ex.: 'wars')
 * @param {string} chave     nome da marca em guildStats (ex.: 'warsHigh')
 */
function marcaDagua(stats, snapshot, campo, chave) {
  const candidatos = [Number(stats?.[chave]), Number(snapshot?.[campo])].filter(Number.isFinite);
  return candidatos.length ? Math.max(...candidatos) : null;
}

// Uma apuração por vez, no processo inteiro.
//
// `takeSnapshots` é chamado de três lugares com cadências diferentes: o job de
// progresso (60 min), o eventTick (1 min, na abertura de um evento) e o
// /points apurar. Uma apuração de 83 membros são centenas de idas ao Mongo e
// leva segundos — tempo de sobra para uma segunda começar no meio.
//
// E aí o estrago é PERMANENTE: as duas leem o MESMO snapshot anterior, calculam
// o MESMO delta e as duas aplicam `$inc: { guildWars: dWars }`. O contador de
// guerra dobra e nada o conserta depois, porque `guildWars` não deriva do
// livro-razão — só é somado. O índice único de pointsEvents também não segura:
// o `meta.snapshotAt` das duas é diferente, então as duas inserções passam e os
// pontos dobram junto.
//
// Quem chega no meio de uma apuração recebe o resultado DELA, em vez de abrir
// outra: para o eventTick, o corte de um snapshot que acabou de sair serve
// igual, e é isso que o `countFrom` precisa.
let emCurso = null;

/**
 * Tira um snapshot de progresso de TODOS os membros da guilda e registra os
 * deltas de guerras/raids/contribuição como eventos de pontos.
 * O snapshot NÃO calcula pontos: quem converte quantidade em ponto é o
 * recompute, usando os pesos vigentes na hora (ver services/points.js).
 *
 * Devolve um resumo, ou `null` se não deu para apurar (sem prefixo configurado
 * ou API fora do ar). Quem cria um evento precisa saber disso: o corte entre o
 * "antes" e o "depois" do evento é justamente este lançamento.
 */
export async function takeSnapshots() {
  if (emCurso) return emCurso;
  emCurso = runSnapshots().finally(() => {
    emCurso = null;
  });
  return emCurso;
}

async function runSnapshots() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return null;

  const res = await fetchGuildMembers(prefix);
  if (!res) return null;

  const season = await ensureActiveSeason();
  const now = new Date();
  const snaps = collections.progressSnapshots();
  const stats = collections.guildStats();
  const part = collections.seasonParticipation();

  let counted = 0;
  for (const m of res.members) {
    const metrics = {
      wars: m.wars,
      raids: m.raids,
      guildRaids: m.guildRaids,
      contributed: m.contributed,
      weeklyCompleted: m.weeklyCompleted,
      weeklyStreak: m.weeklyStreak,
    };

    const last = await snaps
      .find({ uuid: m.uuid })
      .sort({ takenAt: -1 })
      .limit(1)
      .next();
    const atual = await stats.findOne(
      { uuid: m.uuid },
      { projection: { warsHigh: 1, raidsHigh: 1, guildRaidsHigh: 1, contributedHigh: 1 } },
    );

    await snaps.insertOne({
      uuid: m.uuid,
      username: m.username,
      takenAt: now,
      inGuild: true,
      metrics,
    });

    let dWars = 0;
    let dRaids = 0;
    let dGuildRaids = 0;
    let dContrib = 0;

    // Primeiro snapshot de um membro: não há delta, mas há passado.
    //
    // `contributed` e `currentGuildRaids` são absolutos e JÁ escopados à nossa
    // guilda pela API — são literalmente o que a pessoa contribuiu aqui. Entram
    // inteiros como linha de base, senão um veterano com bilhões de XP começaria
    // empatado com quem entrou ontem, e ainda perderia a margem de inatividade.
    //
    // `wars` NÃO entra: o contador da API é da conta inteira, somando guerras de
    // outras guildas. E `weekly` não tem histórico nenhum na API. Esses dois só
    // passam a contar do primeiro snapshot em diante.
    // A marca d'água sai do maior entre o que já está gravado e o último
    // snapshot. O segundo cobre quem ainda não tem marca (membro de antes desta
    // versão): a primeira apuração adota o valor de então e segue daí, em vez
    // de tratar todo mundo como novato.
    const marcaWars = marcaDagua(atual, last?.metrics, 'wars', 'warsHigh');
    const marcaRaids = marcaDagua(atual, last?.metrics, 'raids', 'raidsHigh');
    const marcaGuildRaids = marcaDagua(atual, last?.metrics, 'guildRaids', 'guildRaidsHigh');
    const marcaContrib = marcaDagua(atual, last?.metrics, 'contributed', 'contributedHigh');

    const baseline = !last?.metrics;
    if (baseline) {
      dContrib = metrics.contributed;
      dGuildRaids = metrics.guildRaids;
    } else {
      dWars = novoProgresso(metrics.wars, marcaWars, 2000);
      dRaids = novoProgresso(metrics.raids, marcaRaids, 2000);
      dGuildRaids = novoProgresso(metrics.guildRaids, marcaGuildRaids, 500);
      // Sem teto: Guild XP sobe aos milhões por dia, qualquer cap plausível
      // recusaria uma contribuição legítima.
      dContrib = novoProgresso(metrics.contributed, marcaContrib, 0);
    }

    // A marca só anda para a frente. Um campo que a API devolveu zerado nesta
    // resposta não pode rebaixá-la — é justamente isso que fecha o furo.
    const subir = (marca, valor) => Math.max(Number(marca) || 0, Number(valor) || 0);
    const marcas = {
      warsHigh: subir(marcaWars, metrics.wars),
      raidsHigh: subir(marcaRaids, metrics.raids),
      guildRaidsHigh: subir(marcaGuildRaids, metrics.guildRaids),
      contributedHigh: subir(marcaContrib, metrics.contributed),
    };

    // Quantidades brutas viram eventos. `snapshotAt` torna a gravação idempotente.
    const meta = { snapshotAt: now, ...(baseline && { baseline: true }) };
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'war', qty: dWars, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'raid', qty: dRaids, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'guildRaid', qty: dGuildRaids, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'contribution', qty: dContrib, meta, at: now });
    // Objetivo semanal NÃO entra aqui: a janela diária não enxerga a virada de
    // quem refaz o objetivo logo após o reset semanal. Quem grava é o watcher,
    // que roda a cada 60s (ver recordWeeklyCompletion em services/points.js).

    await stats.updateOne(
      { uuid: m.uuid },
      {
        $set: {
          username: m.username,
          // As marcas d'água, não o valor cru desta resposta. Quando a API
          // devolve o campo zerado, o cru faria a coluna 🛡️ do painel e a conta
          // de aspects caírem para 0 até a próxima apuração; a marca não desce.
          ...marcas,
          lastWars: marcas.warsHigh,
          lastRaids: marcas.raidsHigh,
          contributed: marcas.contributedHigh,
          contributionRank: m.contributionRank,
          // Absoluto e já escopado à guilda pela API — não precisa acumular.
          guildRaids: marcas.guildRaidsHigh,
          weeklyStreak: metrics.weeklyStreak,
          // Data REAL de entrada na guilda (API), usada na regra dos 7 dias de
          // Tomes/aspects. Só grava quando a API traz a data.
          ...(m.joined && { joinedGuildAt: m.joined }),
          updatedAt: now,
        },
        // weeklyObjectives não entra: é derivado do livro-razão pelo recompute.
        $inc: { guildWars: dWars, raidsInGuild: dRaids },
        // Aspects contam do ZERO: a baseline de um membro novo é o guildRaids que
        // ele já tinha ao aparecer, então só os raids futuros geram aspect.
        $setOnInsert: { firstSeenAt: now, aspectBaseRaids: metrics.guildRaids },
      },
      { upsert: true },
    );

    // O BASELINE NÃO ENTRA NA SEASON. Ele carrega a vida inteira do membro na
    // guilda (317 guild raids, bilhões de XP) e existe para o placar ACUMULADO
    // não zerar um veterano. Somado ao delta da season, dava a quem apareceu no
    // primeiro snapshot um saldo de season que ele não fez nesta season — e o
    // ranking de season saía errado sem nunca se corrigir, porque
    // `guildRaidsDelta` e `contributedDelta` só são incrementados, jamais
    // recomputados a partir do livro-razão.
    if (season && !baseline && (dWars > 0 || dRaids > 0 || dGuildRaids > 0 || dContrib > 0)) {
      await part.updateOne(
        { seasonId: season.seasonId, uuid: m.uuid },
        {
          $set: { username: m.username, lastUpdatedAt: now },
          // weeklyDelta idem: derivado do livro-razão pelo recompute.
          $inc: {
            warsFought: dWars,
            raidsDelta: dRaids,
            guildRaidsDelta: dGuildRaids,
            contributedDelta: dContrib,
          },
        },
        { upsert: true },
      );
      if (dWars > 0) counted += dWars;
    }
  }
  log.info(`Snapshot concluído (${res.members.length} membros, +${counted} guerras na season ${season?.seasonId}).`);
  return { members: res.members.length, wars: counted, takenAt: now };
}
