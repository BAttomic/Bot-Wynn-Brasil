import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ACTIVE_STATUSES } from '../discord/commands/loan.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

/**
 * 48h depois de o empréstimo fechar, as cobranças dele somem do CANAL de
 * empréstimos. O TÓPICO fica: é lá que estão o acordo, a lista de itens e a
 * confirmação de recebimento — o registro permanente do que foi emprestado.
 *
 * As 48h existem para o canal continuar contando a história recente: quem
 * devolveu ontem ainda aparece, quem devolveu semana passada já saiu do caminho.
 *
 * Apagamos só as mensagens que o bot guardou por empréstimo (`channelMessageIds`,
 * gravado em jobs/loanReminders.js) — nunca uma varredura do canal. Uma varredura
 * levaria junto o painel fixo e, pior, a mensagem que abre um tópico: apagá-la
 * apaga o tópico inteiro no Discord.
 */
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function runLoanCleanup(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.loans;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const loans = collections.loans();
  const cutoff = new Date(Date.now() - MAX_AGE_MS);

  const fechados = await loans
    .find({
      status: { $nin: ACTIVE_STATUSES }, // repaid | cancelled
      closedAt: { $lte: cutoff },
      channelMessageIds: { $exists: true, $ne: [] },
    })
    .toArray();
  if (!fechados.length) return;

  let apagadas = 0;
  for (const loan of fechados) {
    for (const id of loan.channelMessageIds) {
      const msg = await channel.messages.fetch(id).catch(() => null);
      // Uma mensagem que virou tópico não pode ser apagada: o Discord leva o
      // tópico junto. Não acontece com as cobranças, mas o dia em que alguém
      // abrir um tópico a partir de uma delas, isto segura.
      if (!msg || msg.hasThread) continue;
      await msg.delete().catch(() => {});
      apagadas += 1;
    }
    // Sempre limpa a lista, mesmo se as mensagens já não existiam — senão o job
    // reprocessaria o mesmo empréstimo a cada hora, para sempre.
    await loans.updateOne({ _id: loan._id }, { $unset: { channelMessageIds: '' } });
  }

  if (apagadas) {
    log.info(`Canal de empréstimos: ${apagadas} cobrança(s) apagada(s) de ${fechados.length} empréstimo(s) fechado(s) há mais de 48h.`);
  }
}
