import { loadEnv, required } from './config/env.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { createClient } from './discord/client.js';
import { registerCommands, attachHandlers } from './discord/commandLoader.js';
import { everySeconds, everyMinutes, dailyAt, clearJobs } from './jobs/scheduler.js';
import { runRoleSync } from './jobs/roleSync.js';
import { runApplicationExpiry } from './jobs/applicationExpiry.js';
import { runProgressSnapshot } from './jobs/progressSnapshot.js';
import { runLoanReminders } from './jobs/loanReminders.js';
import { runVerificationReport } from './jobs/verificationReport.js';
import { runGuildWatch } from './services/watcher.js';
import { ensurePanels, attachRegistrationGuard } from './services/registration.js';
import { ensureStaticPanels } from './services/staticPanels.js';
import { ensurePingRolePanels, attachPingRoleHandler } from './services/pingRoles.js';
import { ensureLeaderboardPanel } from './services/leaderboardPanel.js';
import { runPingsCleanup } from './jobs/pingsCleanup.js';
import { ensureActiveSeason } from './services/seasons.js';
import { initErrorReport, reportError } from './services/errorReport.js';
import { getConfig } from './config/guildConfig.js';
import { startHealthServer } from './health.js';
import { log } from './util/log.js';

let ready = false;

/**
 * Loga no Discord com backoff. O gateway às vezes responde 503 (indisponível),
 * e sem retry esse hipo transiente derrubaria o processo no boot — o container
 * reiniciaria e tentaria de novo, virando um crash-loop enquanto o Discord
 * estivesse instável. Aqui a gente só espera e tenta de novo, sem morrer.
 *
 * @param {import('discord.js').Client} client
 * @param {string} token
 * @param {number} [tentativas]
 */
async function loginWithRetry(client, token, tentativas = 6) {
  for (let i = 1; i <= tentativas; i += 1) {
    try {
      await client.login(token);
      return;
    } catch (e) {
      if (i === tentativas) throw e;
      const espera = Math.min(60_000, 2 ** i * 1000); // 2s, 4s, 8s… teto de 60s
      log.warn(`Falha no login (tentativa ${i}/${tentativas}): ${e.message}. Nova tentativa em ${espera / 1000}s.`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

async function main() {
  loadEnv();
  const token = required('DISCORD_TOKEN');
  required('DISCORD_CLIENT_ID');
  const guildId = required('DISCORD_GUILD_ID');

  startHealthServer(() => ready);

  await connectMongo();
  await registerCommands();

  const client = createClient();
  attachHandlers(client, { log });
  attachRegistrationGuard(client);

  client.on('error', (e) => {
    log.error('Discord client error:', e);
    reportError('Discord client error', e);
  });
  client.on('shardError', (e) => {
    log.error('Shard error:', e);
    reportError('Shard error', e);
  });

  client.once('clientReady', async () => {
    ready = true;
    log.info(`Logado como ${client.user.tag}`);
    initErrorReport(client, guildId);
    attachPingRoleHandler(client);
    const cfg = await getConfig(guildId);
    const minutes = Number(cfg.params?.roleSyncMinutes) || 10;
    const snapH = Number(cfg.params?.snapshotHourUTC) || 5;
    const loanH = Number(cfg.params?.loanReminderHourUTC) || 12;
    const watchS = Number(cfg.params?.watcherSeconds) || 60;
    const verifyH = Number(cfg.params?.verifyHourUTC) || 12;

    // Se alguém apagar um painel fixo, ele volta no próximo ciclo.
    everyMinutes(5, 'panels', async () => {
      await ensurePanels(client, guildId);
      await ensureStaticPanels(client, guildId);
      await ensurePingRolePanels(client, guildId);
      await ensureLeaderboardPanel(client, guildId);
    }, { runOnStart: true });
    everyMinutes(60, 'pingsCleanup', () => runPingsCleanup(client), { runOnStart: true });
    // Vira a season (ou entra em off-season) assim que o jogo virar.
    everyMinutes(60, 'seasonSync', () => ensureActiveSeason(), { runOnStart: true });
    everyMinutes(minutes, 'roleSync', () => runRoleSync(client), { runOnStart: true });
    everyMinutes(1, 'applicationExpiry', () => runApplicationExpiry(client));
    everySeconds(watchS, 'guildWatch', () => runGuildWatch(client), { runOnStart: true });
    dailyAt(snapH, 0, 'progressSnapshot', () => runProgressSnapshot());
    dailyAt(loanH, 0, 'loanReminders', () => runLoanReminders(client));
    dailyAt(verifyH, 0, 'verificationReport', () => runVerificationReport(client));
  });

  await loginWithRetry(client, token);

  const shutdown = async () => {
    log.info('Encerrando...');
    ready = false;
    clearJobs();
    await client.destroy();
    await closeMongo();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (e) => {
    log.error('Unhandled rejection:', e);
    reportError('Unhandled rejection', e);
  });
  process.on('uncaughtException', (e) => {
    log.error('Uncaught exception:', e);
    reportError('Uncaught exception', e);
  });
}

main().catch((e) => {
  log.error('Falha na inicialização:', e);
  process.exit(1);
});
