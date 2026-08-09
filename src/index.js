import { loadEnv, required } from './config/env.js';
import { connectMongo, closeMongo } from './db/mongo.js';
import { createClient } from './discord/client.js';
import { registerCommands, attachHandlers } from './discord/commandLoader.js';
import { everySeconds, everyMinutes, dailyAt, clearJobs } from './jobs/scheduler.js';
import { runRoleSync } from './jobs/roleSync.js';
import { runWarQueue } from './jobs/warQueue.js';
import { runApplicationExpiry } from './jobs/applicationExpiry.js';
import { runProgressSnapshot } from './jobs/progressSnapshot.js';
import { runLoanReminders } from './jobs/loanReminders.js';
import { runLoanCleanup } from './jobs/loanCleanup.js';
import { runBoothReminders } from './jobs/boothReminders.js';
import { runEventTick } from './jobs/eventTick.js';
import { runGiveawayDraw } from './jobs/giveawayDraw.js';
import { runVerificationReport } from './jobs/verificationReport.js';
import { runInactivityCheck } from './services/inactivityCheck.js';
import { runGuildWatch, flushTerritoryDigest } from './services/watcher.js';
import { ensurePanels, attachRegistrationGuard } from './services/registration.js';
import { ensureStaticPanels } from './services/staticPanels.js';
import { ensurePingRolePanels, attachPingRoleHandler } from './services/pingRoles.js';
import { ensureDownloadsPanel, ensureLeaderboardPanel } from './services/leaderboardPanel.js';
import { ensureTomePanel } from './services/tomes.js';
import { ensureAspectBaselines } from './services/aspects.js';
import { runPingsCleanup } from './jobs/pingsCleanup.js';
import { runTomeCleanup } from './jobs/tomeCleanup.js';
import { runRecruitCleanup } from './jobs/recruitCleanup.js';
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
  // Fixa a baseline dos aspects no valor atual de guild raids: todo mundo passa
  // a contar do ZERO a partir de agora. Idempotente (só mexe em quem falta).
  await ensureAspectBaselines();
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
      await ensureTomePanel(client, guildId);
      // Ordem no canal de status: info (ao vivo) → downloads → leaderboard.
      await ensureDownloadsPanel(client, guildId);
      await ensureLeaderboardPanel(client, guildId);
    }, { runOnStart: true });
    everyMinutes(60, 'pingsCleanup', () => runPingsCleanup(client), { runOnStart: true });
    // Anúncios de entrega de tome/aspect somem 3 dias depois (o painel fica).
    everyMinutes(60, 'tomeCleanup', () => runTomeCleanup(client), { runOnStart: true });
    everyMinutes(30, 'recruitCleanup', () => runRecruitCleanup(client), { runOnStart: true });
    // Cobranças de empréstimo somem do canal 48h depois de o acordo fechar; o
    // tópico com o acordo fica.
    everyMinutes(60, 'loanCleanup', () => runLoanCleanup(client), { runOnStart: true });
    // Check-in de inatividade: pergunta no privado antes de qualquer expulsão.
    // De hora em hora (e não uma vez por dia) para que o prazo de resposta
    // comece assim que a margem estoura, e não até 24h depois.
    everyMinutes(60, 'inactivityCheck', () => runInactivityCheck(client), { runOnStart: true });
    // Vira a season (ou entra em off-season) assim que o jogo virar.
    everyMinutes(60, 'seasonSync', () => ensureActiveSeason(), { runOnStart: true });
    everyMinutes(minutes, 'roleSync', () => runRoleSync(client), { runOnStart: true });
    // Depende do `inGuild` que o roleSync mantém, então roda com folga sobre ele.
    everyMinutes(30, 'warQueue', () => runWarQueue(client), { runOnStart: true });
    everyMinutes(1, 'applicationExpiry', () => runApplicationExpiry(client));
    everyMinutes(1, 'boothReminders', () => runBoothReminders(client));
    // O prazo de um sorteio é curto e público — precisa fechar no minuto certo.
    everyMinutes(1, 'giveawayDraw', () => runGiveawayDraw(client));
    // Um evento marcado para as 00:00 tem que abrir às 00:00: o corte da
    // contagem de guerra e XP acontece na abertura, e o que ficar entre o
    // horário marcado e o corte não é contado para ninguém. De 1 em 1 minuto
    // essa folga fica em no máximo 60s (era de até 5 min). As guild raids não
    // esperam por isto: o watcher credita cada uma na hora.
    everyMinutes(1, 'eventTick', () => runEventTick(client), { runOnStart: true });
    everySeconds(watchS, 'guildWatch', () => runGuildWatch(client), { runOnStart: true });
    // O resumo agrupado de território decide sozinho quando é hora (anti-spam).
    everyMinutes(5, 'territoryDigest', () => flushTerritoryDigest(client));
    // DE HORA EM HORA, não uma vez por dia: o leaderboard, os pontos e a margem
    // de inatividade saem daqui, e um painel que só muda de madrugada parece
    // quebrado. Rodar mais vezes não pontua duas vezes — cada apuração tem seu
    // `snapshotAt`, e o índice único de pointsEvents recusa a repetição.
    // `snapshotHourUTC` deixou de valer como cadência: agora é só o horário do
    // reforço diário, que continua para o caso do bot passar horas fora do ar.
    everyMinutes(60, 'progressSnapshot', () => runProgressSnapshot(client), { runOnStart: true });
    dailyAt(snapH, 0, 'progressSnapshot(diário)', () => runProgressSnapshot(client));
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
