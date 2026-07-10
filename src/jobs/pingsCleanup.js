import { getConfig } from '../config/guildConfig.js';
import { panelMessageId } from '../services/panels.js';
import { PINGS_STATE_ID } from '../services/staticPanels.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const MAX_AGE_MS = 48 * 60 * 60 * 1000;

// O Discord só apaga em lote mensagens com menos de 14 dias. Acima disso é uma
// chamada por mensagem — mas como rodamos de hora em hora, nada chega lá.
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

export async function runPingsCleanup(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.pings;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const panelId = await panelMessageId(PINGS_STATE_ID);
  const cutoff = Date.now() - MAX_AGE_MS;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;

  const expired = messages.filter(
    (m) => m.id !== panelId && m.createdTimestamp < cutoff && !m.pinned,
  );
  if (!expired.size) return;

  const now = Date.now();
  const bulk = expired.filter((m) => now - m.createdTimestamp < BULK_LIMIT_MS);
  const old = expired.filter((m) => now - m.createdTimestamp >= BULK_LIMIT_MS);

  if (bulk.size) await channel.bulkDelete(bulk, true).catch(() => {});
  for (const m of old.values()) await m.delete().catch(() => {});

  log.info(`Canal de pings: ${expired.size} mensagem(ns) com mais de 48h apagada(s).`);
}
