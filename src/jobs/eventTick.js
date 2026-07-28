import { collections } from '../db/mongo.js';
import { optional } from '../config/env.js';
import {
  METRICS,
  activeEvents,
  hasStarted,
  refreshScores,
  ensureEventPanel,
  endEvent,
} from '../services/events.js';
import { takeSnapshots } from '../services/progress.js';
import { log } from '../util/log.js';

/**
 * Abre o evento agendado no horário, mantém o painel vivo e encerra quem passou
 * do prazo (anunciando o pódio).
 *
 * Roda sozinho porque nada disso pode depender de alguém rodar um comando — um
 * evento marcado para as 00:00 do dia 29 tem que abrir às 00:00 do dia 29, e um
 * de duas semanas tem que fechar no dia certo mesmo se ninguém olhar.
 *
 * @param {import('discord.js').Client} client
 */
export async function runEventTick(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const events = await activeEvents(guildDiscordId);
  if (!events.length) return;

  const now = new Date();
  let encerrados = 0;
  let abertos = 0;

  for (const event of events) {
    if (!hasStarted(event, now)) {
      // Ainda não abriu: o painel só mostra a contagem regressiva.
      await ensureEventPanel(client, event);
      continue;
    }

    // ABERTURA de um evento agendado, em métrica SEM gatilho.
    //
    // Guerra e XP vêm do delta da contagem diária, e esse delta atravessa a hora
    // da abertura. Apurar agora fecha o pedaço anterior no passado e fixa o
    // corte (`countFrom`) no instante real da apuração — senão o primeiro
    // lançamento traria junto horas em que o evento nem tinha começado.
    if (!event.countFrom && !METRICS[event.metric]?.live) {
      const snap = await takeSnapshots();
      const corte = snap?.takenAt ?? now;
      await collections.events().updateOne({ eventId: event.eventId }, { $set: { countFrom: corte } });
      event.countFrom = corte;
      abertos += 1;
      log.info(`Evento ${event.eventId} abriu; contagem cortada em ${corte.toISOString()}.`);
    }

    if (new Date(event.endAt) <= now) {
      await endEvent(client, event);
      encerrados += 1;
      continue;
    }

    await refreshScores(event);
    await ensureEventPanel(client, event);
  }

  if (abertos) log.info(`Eventos abertos no horário: ${abertos}.`);
  if (encerrados) log.info(`Eventos encerrados no prazo: ${encerrados}.`);
}
