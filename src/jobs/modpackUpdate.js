import { refreshModpack } from '../services/modpack.js';
import { audit } from '../services/audit.js';
import { reportError } from '../services/errorReport.js';
import { log } from '../util/log.js';

/**
 * Última falha de resolução já avisada. O job roda de 6 em 6 horas, e um mod que
 * ficou para trás continua para trás — sem isto, a mesma mensagem cairia no
 * canal quatro vezes por dia até alguém mexer no manifesto.
 * @type {string|null}
 */
let ultimaFalha = null;

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
  let resultado;
  try {
    resultado = await refreshModpack();
  } catch (e) {
    // Mod sem versão para o Minecraft fixado é DECISÃO, não bug: ou o mod
    // parou no meio do caminho, ou chegou a hora de subir a versão do jogo no
    // manifesto. Quem decide é a staff, então isso precisa aparecer no canal —
    // o pack inteiro para de atualizar até alguém resolver.
    if (e.code === 'MODPACK_UNRESOLVED') {
      if (e.message !== ultimaFalha) {
        ultimaFalha = e.message;
        await reportError(
          'Modpack não atualizou',
          `${e.message}\n\nO pack anterior continua no ar. Para destravar: suba "minecraft" ` +
          'em src/data/modpack.json, ou tire o mod da lista.',
        );
      }
      log.warn(`Modpack não atualizou — ${e.message}`);
      return;
    }
    throw e;
  }
  ultimaFalha = null;

  const { state, changed } = resultado;
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
