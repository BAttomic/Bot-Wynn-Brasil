import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const DAY_MS = 86_400_000;

/**
 * Quantas vezes um atraso é cobrado antes de o bot calar a boca. Passado esse
 * ponto o problema é humano, não de lembrete — e cobrar todo dia para sempre só
 * ensina o canal a ser ignorado.
 */
const MAX_OVERDUE_REMINDERS = 5;

/** Intervalo mínimo entre duas cobranças do MESMO empréstimo. */
const REMINDER_GAP_MS = DAY_MS;

/** @param {object} loan @returns {string} */
function describe(loan) {
  return loan.type === 'emeralds' ? `${loan.amount} esmeraldas` : loan.itemDesc;
}

/**
 * Avisa no canal de empréstimos sobre vencimentos próximos (24h) e atrasos.
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function runLoanReminders(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.loans;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const loans = collections.loans();
  const now = new Date();

  // Promove os vencidos. `overdue` continua sendo um estado ATIVO: o /loan repay
  // aceita os dois, e o /loan list mostra os dois.
  await loans.updateMany(
    { status: 'open', dueAt: { $lt: now } },
    { $set: { status: 'overdue' } },
  );

  // Vence nas próximas 24h e ainda não foi avisado.
  const dueSoon = await loans
    .find({
      status: 'open',
      dueAt: { $lte: new Date(now.getTime() + DAY_MS) },
      dueSoonNotified: { $ne: true },
    })
    .toArray();

  for (const loan of dueSoon) {
    await channel.send({
      content: `⏰ <@${loan.borrowerDiscordId}>, seu empréstimo (**${describe(loan)}**) vence <t:${Math.floor(new Date(loan.dueAt).getTime() / 1000)}:R>.`,
    });
    await loans.updateOne({ _id: loan._id }, { $set: { dueSoonNotified: true, lastReminderAt: now } });
  }

  // Atrasados: no máximo uma cobrança por dia, e no máximo MAX_OVERDUE_REMINDERS.
  const overdue = await loans
    .find({
      status: 'overdue',
      overdueReminders: { $lt: MAX_OVERDUE_REMINDERS },
      $or: [
        { lastReminderAt: null },
        { lastReminderAt: { $exists: false } },
        { lastReminderAt: { $lte: new Date(now.getTime() - REMINDER_GAP_MS) } },
      ],
    })
    .toArray();

  for (const loan of overdue) {
    const sent = (loan.overdueReminders ?? 0) + 1;
    const last = sent >= MAX_OVERDUE_REMINDERS ? '\n-# Último aviso automático. A staff assume daqui.' : '';
    await channel.send({
      content: `🚨 <@${loan.borrowerDiscordId}>, seu empréstimo (**${describe(loan)}**) está **atrasado**! (aviso ${sent}/${MAX_OVERDUE_REMINDERS})${last}`,
    });
    await loans.updateOne({ _id: loan._id }, { $set: { overdueReminders: sent, lastReminderAt: now } });
  }

  if (dueSoon.length || overdue.length) {
    log.info(`Lembretes de empréstimo: ${dueSoon.length} a vencer, ${overdue.length} cobrança(s) de atraso.`);
  }
}
