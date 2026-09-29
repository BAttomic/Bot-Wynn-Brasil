import { escapeMarkdown } from 'discord.js';

const USER = /<@!?(\d{15,25})>/g;
const ROLE = /<@&(\d{15,25})>/g;

/**
 * Troca menção de pessoa e de cargo por texto puro: `<@123>` vira `@Fulano`, e
 * `<@&456>`, `@Capitão (War)`.
 *
 * Para o 🤖・staff-bot, que não pode ter ping NENHUM. O `allowedMentions` já
 * impede a notificação, mas a menção continua na tela como um @ clicável, que
 * para quem lê é um ping. Texto puro não notifica, não destaca, não vira link.
 * Menção de canal (`<#id>`) fica: é link, não ping.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild | string | null} guildOrId
 * @param {string} texto
 * @returns {Promise<string>}
 */
export async function plainMentions(client, guildOrId, texto) {
  if (typeof texto !== 'string' || !texto.includes('<@')) return texto;
  const guild =
    typeof guildOrId === 'string'
      ? client.guilds.cache.get(guildOrId) ?? (await client.guilds.fetch(guildOrId).catch(() => null))
      : guildOrId;

  const nomes = new Map();
  for (const [, id] of texto.matchAll(USER)) {
    if (nomes.has(id)) continue;
    const membro = guild?.members.cache.get(id);
    const user = membro?.user ?? client.users.cache.get(id) ?? (await client.users.fetch(id).catch(() => null));
    nomes.set(id, membro?.displayName ?? user?.globalName ?? user?.username ?? 'usuário desconhecido');
  }

  return texto
    .replace(USER, (_, id) => `@${escapeMarkdown(nomes.get(id))}`)
    .replace(ROLE, (_, id) => `@${escapeMarkdown(guild?.roles.cache.get(id)?.name ?? 'cargo apagado')}`);
}
