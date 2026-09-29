import { getConfig } from '../config/guildConfig.js';
import { plainMentions } from '../util/plainMentions.js';
import { log } from '../util/log.js';

// Envia uma linha de auditoria para o canal "logs" configurado (se houver).
//
// Sem ping NENHUM: quem chama pode escrever `<@id>` e `<@&id>` à vontade, que
// aqui eles viram texto puro (ver util/plainMentions.js).
export async function audit(client, guildDiscordId, content) {
  try {
    const cfg = await getConfig(guildDiscordId);
    const channelId = cfg.channels?.logs;
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const texto = await plainMentions(client, guildDiscordId, content);
    if (channel) await channel.send({ content: `📋 ${texto}`, allowedMentions: { parse: [] } });
  } catch (e) {
    log.error('Falha ao registrar auditoria:', e);
  }
}
