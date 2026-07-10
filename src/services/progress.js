import { collections } from '../db/mongo.js';
import { fetchGuildMembers } from './guildData.js';
import { ensureActiveSeason } from './seasons.js';
import { recordEvent } from './points.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Ignora deltas negativos (reset/troca de UUID) ou absurdamente grandes.
function safeDelta(current, previous, cap) {
  const d = current - previous;
  if (d <= 0) return 0;
  if (cap && d > cap) return 0;
  return d;
}

// Tira um snapshot diário de progresso de TODOS os membros da guilda e
// registra os deltas de guerras/raids/contribuição como eventos de pontos.
// O snapshot NÃO calcula pontos: quem converte quantidade em ponto é o
// recompute, usando os pesos vigentes na hora (ver services/points.js).
export async function takeSnapshots() {
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!prefix) return;

  const res = await fetchGuildMembers(prefix);
  if (!res) return;

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
    let dWeekly = 0;

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
    const baseline = !last?.metrics;
    if (baseline) {
      dContrib = metrics.contributed;
      dGuildRaids = metrics.guildRaids;
    } else {
      dWars = safeDelta(metrics.wars, last.metrics.wars, 2000);
      dRaids = safeDelta(metrics.raids, last.metrics.raids, 2000);
      dGuildRaids = safeDelta(metrics.guildRaids, last.metrics.guildRaids ?? 0, 500);
      dContrib = Math.max(0, metrics.contributed - (last.metrics.contributed ?? 0));
      // A API só diz se o objetivo desta semana está feito, não quantos já foram.
      // Contamos a virada de "não fez" para "fez"; como o snapshot é diário e o
      // objetivo é semanal, cada semana concluída é contada uma vez só.
      // `weeklyCompleted` é null sem WYNN_API_KEY — aí não contamos nada.
      if (metrics.weeklyCompleted === true && last.metrics.weeklyCompleted === false) dWeekly = 1;
    }

    // Quantidades brutas viram eventos. `snapshotAt` torna a gravação idempotente.
    const meta = { snapshotAt: now, ...(baseline && { baseline: true }) };
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'war', qty: dWars, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'raid', qty: dRaids, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'guildRaid', qty: dGuildRaids, meta, at: now });
    await recordEvent({ uuid: m.uuid, username: m.username, type: 'contribution', qty: dContrib, meta, at: now });
    // A sequência viaja no evento: o bônus de streak é recalculado a partir dela
    // sempre que os pesos mudarem, como todo o resto do histórico.
    await recordEvent({
      uuid: m.uuid,
      username: m.username,
      type: 'weekly',
      qty: dWeekly,
      meta: { ...meta, streak: metrics.weeklyStreak },
      at: now,
    });

    await stats.updateOne(
      { uuid: m.uuid },
      {
        $set: {
          username: m.username,
          lastWars: metrics.wars,
          lastRaids: metrics.raids,
          contributed: metrics.contributed,
          contributionRank: m.contributionRank,
          // Absoluto e já escopado à guilda pela API — não precisa acumular.
          guildRaids: metrics.guildRaids,
          weeklyStreak: metrics.weeklyStreak,
          updatedAt: now,
        },
        $inc: { guildWars: dWars, raidsInGuild: dRaids, weeklyObjectives: dWeekly },
        $setOnInsert: { firstSeenAt: now },
      },
      { upsert: true },
    );

    if (season && (dWars > 0 || dRaids > 0 || dGuildRaids > 0 || dContrib > 0 || dWeekly > 0)) {
      await part.updateOne(
        { seasonId: season.seasonId, uuid: m.uuid },
        {
          $set: { username: m.username, lastUpdatedAt: now },
          $inc: {
            warsFought: dWars,
            raidsDelta: dRaids,
            guildRaidsDelta: dGuildRaids,
            contributedDelta: dContrib,
            weeklyDelta: dWeekly,
          },
        },
        { upsert: true },
      );
      if (dWars > 0) counted += dWars;
    }
  }
  log.info(`Snapshot concluído (${res.members.length} membros, +${counted} guerras na season ${season?.seasonId}).`);
}
