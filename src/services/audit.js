import { getConfig } from '../config/guildConfig.js';
import { log } from '../util/log.js';

// Envia uma linha de auditoria para o canal "logs" configurado (se houver).
export async function audit(client, guildDiscordId, content) {
  try {
    const cfg = await getConfig(guildDiscordId);
    const channelId = cfg.channels?.logs;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (channel) await channel.send({ content: `📋 ${content}`, allowedMentions: { parse: [] } });
  } catch (e) {
    log.error('Falha ao registrar auditoria:', e);
  }
}
