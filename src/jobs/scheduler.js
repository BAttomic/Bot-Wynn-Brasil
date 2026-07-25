import { log } from '../util/log.js';

// Scheduler mínimo, sem dependências (setInterval / setTimeout).
const timers = [];

export function everySeconds(seconds, name, fn, { runOnStart = false } = {}) {
  const ms = Math.max(5, seconds) * 1000;
  const wrapped = async () => {
    try {
      await fn();
    } catch (e) {
      log.error(`Job "${name}" falhou:`, e);
    }
  };
  if (runOnStart) wrapped();
  timers.push(setInterval(wrapped, ms));
  log.info(`Job agendado: ${name} (a cada ${seconds}s)`);
}

export function everyMinutes(minutes, name, fn, { runOnStart = false } = {}) {
  const ms = Math.max(1, minutes) * 60_000;
  const wrapped = async () => {
    try {
      await fn();
    } catch (e) {
      log.error(`Job "${name}" falhou:`, e);
    }
  };
  if (runOnStart) wrapped();
  timers.push(setInterval(wrapped, ms));
  log.info(`Job agendado: ${name} (a cada ${minutes} min)`);
}

// Agenda uma execução diária num horário UTC. Reagenda a si mesmo.
export function dailyAt(hourUTC, minuteUTC, name, fn) {
  const schedule = () => {
    const now = new Date();
    const next = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC, minuteUTC, 0),
    );
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next - now;
    timers.push(
      setTimeout(async () => {
        try {
          await fn();
        } catch (e) {
          log.error(`Job "${name}" falhou:`, e);
        }
        schedule();
      }, delay),
    );
  };
  schedule();
  log.info(
    `Job diário agendado: ${name} (${String(hourUTC).padStart(2, '0')}:${String(minuteUTC).padStart(2, '0')} UTC)`,
  );
}

export function clearJobs() {
  timers.forEach((t) => {
    clearInterval(t);
    clearTimeout(t);
  });
}
