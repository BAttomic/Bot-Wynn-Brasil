import { getConfig } from '../config/guildConfig.js';
import { panelMessageId } from '../services/panels.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

// O Discord só apaga em lote mensagens com menos de 14 dias. Acima disso é uma
// chamada por mensagem — o que só acontece se o bot ficar dias fora do ar.
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Limpa o canal de Tomes: os anúncios de entrega ("Tome entregue a X") somem 3
 * dias depois. É um canal de fila, não de histórico — o registro permanente é a
 * auditoria e o `guildStats.tomesDelivered`.
 *
 * Agendado (e não um setTimeout na hora do envio) porque um timer de 3 dias não
 * sobreviveria ao restart do bot.
 */
export async function runTomeCleanup(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.tome;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // O painel ao vivo é uma mensagem do bot e envelhece como qualquer outra —
  // sem esta exclusão, a limpeza apagaria a própria fila.
  const panelId = await panelMessageId('tomePanel');
  const cutoff = Date.now() - MAX_AGE_MS;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;

  const expired = messages.filter(
    (m) => m.id !== panelId && m.author?.id === client.user.id && m.createdTimestamp < cutoff && !m.pinned,
  );
  if (!expired.size) return;

  const now = Date.now();
  const bulk = expired.filter((m) => now - m.createdTimestamp < BULK_LIMIT_MS);
  const old = expired.filter((m) => now - m.createdTimestamp >= BULK_LIMIT_MS);

  if (bulk.size) await channel.bulkDelete(bulk, true).catch(() => {});
  for (const m of old.values()) await m.delete().catch(() => {});

  log.info(`Canal de tomes: ${expired.size} anúncio(s) com mais de 3 dias apagado(s).`);
}
