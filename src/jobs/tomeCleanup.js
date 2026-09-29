import { getConfig } from '../config/guildConfig.js';
import { panelMessageId } from '../services/panels.js';
import { REWARD_PANEL_STATE_IDS } from '../services/tomes.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

// O Discord só apaga em lote mensagens com menos de 14 dias. Acima disso é uma
// chamada por mensagem — o que só acontece se o bot ficar dias fora do ar.
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Limpa o canal de recompensas: mensagem solta do bot some 24h depois. É um
 * canal de painéis, não de histórico — o registro permanente é a auditoria, os
 * acumulados em `guildStats` e o log de entregas de cada painel.
 *
 * Agendado (e não um setTimeout na hora do envio) porque um timer de 24h não
 * sobreviveria ao restart do bot. O job roda de hora em hora, então na prática
 * uma mensagem vive entre 24h e 25h — o "no máximo" é aproximado por cima, e
 * apertar isso custaria um ciclo mais frequente sem ganho nenhum.
 */
export async function runTomeCleanup(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  if (!guildDiscordId) return;

  const cfg = await getConfig(guildDiscordId);
  const channelId = cfg.channels?.tome;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Os painéis fixos (Tomes, Aspects, Esmeraldas) são mensagens do bot e
  // envelhecem como qualquer outra. Sem esta exclusão a limpeza apagaria os
  // próprios painéis 24h depois de publicados.
  const panelIds = new Set(
    (await Promise.all(REWARD_PANEL_STATE_IDS.map((id) => panelMessageId(id)))).filter(Boolean),
  );
  const cutoff = Date.now() - MAX_AGE_MS;

  const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return;

  const expired = messages.filter(
    (m) => !panelIds.has(m.id) && m.author?.id === client.user.id && m.createdTimestamp < cutoff && !m.pinned,
  );
  if (!expired.size) return;

  const now = Date.now();
  const bulk = expired.filter((m) => now - m.createdTimestamp < BULK_LIMIT_MS);
  const old = expired.filter((m) => now - m.createdTimestamp >= BULK_LIMIT_MS);

  if (bulk.size) await channel.bulkDelete(bulk, true).catch(() => {});
  for (const m of old.values()) await m.delete().catch(() => {});

  log.info(`Canal de recompensas: ${expired.size} mensagem(ns) com mais de 24h apagada(s).`);
}
