import { getConfig } from '../config/guildConfig.js';
import { log } from '../util/log.js';

let clientRef = null;
let guildRef = null;

export function initErrorReport(client, guildDiscordId) {
  clientRef = client;
  guildRef = guildDiscordId;
}

// Encaminha um erro para o canal "errors" (fallback: "logs").
export async function reportError(title, err) {
  try {
    if (!clientRef || !guildRef) return;
    const cfg = await getConfig(guildRef);
    const channelId = cfg.channels?.errors || cfg.channels?.logs;
    if (!channelId) return;
    const channel = await clientRef.channels.fetch(channelId).catch(() => null);
    if (!channel) return;
    const body = (err?.stack || String(err)).slice(0, 1800);
    await channel.send({ content: `🛑 **${title}**\n\`\`\`\n${body}\n\`\`\``, allowedMentions: { parse: [] } });
  } catch (e) {
    log.error('Falha ao reportar erro no Discord:', e);
  }
}
