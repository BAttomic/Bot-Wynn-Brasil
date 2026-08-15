import { refreshModpack } from '../services/modpack.js';
import { audit } from '../services/audit.js';
import { log } from '../util/log.js';

/**
 * Mantém o modpack em dia: resolve a versão mais recente de cada mod no Modrinth
 * e regera o .mrpack e o .zip quando alguma mudou (ver services/modpack.js).
 *
 * Quando nada muda — o caso comum — não escreve nada e não avisa ninguém. Quando
 * muda, a linha vai para o canal de auditoria: a staff precisa saber que o pack
 * mexeu, porque é ela quem responde no chat quando um mod quebra depois de uma
 * atualização.
 *
 * @param {import('discord.js').Client} client
 * @param {string} guildDiscordId
 */
export async function runModpackUpdate(client, guildDiscordId) {
  const { state, changed } = await refreshModpack();
  if (!changed.length) return;

  const linhas = changed.map((c) => `• **${c.name}**: ${c.from ?? '—'} → ${c.to}`);
  log.info(`Modpack atualizado (${state.packVersion}): ${changed.map((c) => c.name).join(', ')}`);
  await audit(
    client,
    guildDiscordId,
    `📦 Modpack atualizado para \`${state.packVersion}\`:\n${linhas.join('\n')}\n` +
    '-# Quem instalou pelo `.mrpack` recebe a atualização no launcher; quem baixou o `.zip` precisa baixar de novo.',
  );
}
