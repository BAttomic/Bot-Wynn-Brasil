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
import { ensureActiveSeason } from './services/seasons.js';
import { initErrorReport, reportError } from './services/errorReport.js';
import { getConfig } from './config/guildConfig.js';
import { startHealthServer } from './health.js';
import { log } from './util/log.js';

let ready = false;

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
    const cfg = await getConfig(guildId);
    const minutes = Number(cfg.params?.roleSyncMinutes) || 10;
    const snapH = Number(cfg.params?.snapshotHourUTC) || 5;
    const loanH = Number(cfg.params?.loanReminderHourUTC) || 12;
    const watchS = Number(cfg.params?.watcherSeconds) || 60;
    const verifyH = Number(cfg.params?.verifyHourUTC) || 12;

    // Se alguém apagar um painel fixo, ele volta no próximo ciclo.
    everyMinutes(5, 'panels', () => ensurePanels(client, guildId), { runOnStart: true });
    // Vira a season (ou entra em off-season) assim que o jogo virar.
    everyMinutes(60, 'seasonSync', () => ensureActiveSeason(), { runOnStart: true });
    everyMinutes(minutes, 'roleSync', () => runRoleSync(client), { runOnStart: true });
    everyMinutes(1, 'applicationExpiry', () => runApplicationExpiry(client));
    everySeconds(watchS, 'guildWatch', () => runGuildWatch(client), { runOnStart: true });
    dailyAt(snapH, 0, 'progressSnapshot', () => runProgressSnapshot());
    dailyAt(loanH, 0, 'loanReminders', () => runLoanReminders(client));
    dailyAt(verifyH, 0, 'verificationReport', () => runVerificationReport(client));
  });

  await client.login(token);

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
