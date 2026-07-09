import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

// Avisa no canal de empréstimos sobre vencimentos próximos (24h) e atrasos.
export async function runLoanReminders(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;
  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.loans;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const now = Date.now();
  const soon = new Date(now + 86_400_000);
  const loans = collections.loans();

  // Marca atrasados.
  await loans.updateMany(
    { status: 'open', dueAt: { $lt: new Date(now) } },
    { $set: { status: 'overdue' } },
  );

  const dueSoon = await loans.find({ status: 'open', dueAt: { $lte: soon } }).toArray();
  const overdue = await loans.find({ status: 'overdue' }).toArray();

  for (const l of dueSoon) {
    const val = l.type === 'emeralds' ? `${l.amount} esmeraldas` : l.itemDesc;
    await channel.send({
      content: `⏰ Lembrete: <@${l.borrowerDiscordId}>, seu empréstimo (**${val}**) vence <t:${Math.floor(new Date(l.dueAt).getTime() / 1000)}:R>.`,
    });
  }
  for (const l of overdue) {
    const val = l.type === 'emeralds' ? `${l.amount} esmeraldas` : l.itemDesc;
    await channel.send({
      content: `🚨 <@${l.borrowerDiscordId}>, seu empréstimo (**${val}**) está **atrasado**!`,
    });
  }
  if (dueSoon.length || overdue.length) {
    log.info(`Lembretes de empréstimo: ${dueSoon.length} a vencer, ${overdue.length} atrasados.`);
  }
}
