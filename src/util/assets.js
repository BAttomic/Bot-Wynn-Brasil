import { AttachmentBuilder } from 'discord.js';
import { fileURLToPath } from 'node:url';

// Logo oficial da guilda, usado como marca-d'água (thumbnail) nos painéis fixos.
// Fica em src/assets/ e entra na imagem Docker.
export const LOGO_FILE = 'WnBR_Logo.jpg';

/** URL interna que um embed usa para apontar para o anexo do logo. */
export const LOGO_URL = `attachment://${LOGO_FILE}`;

/**
 * Anexo do logo. Só precisa acompanhar a mensagem na CRIAÇÃO: em edições o
 * Discord preserva o anexo, então o `attachment://` continua resolvendo sem
 * reenviar o arquivo. @returns {AttachmentBuilder}
 */
export function logoAttachment() {
  const filePath = fileURLToPath(new URL(`../assets/${LOGO_FILE}`, import.meta.url));
  return new AttachmentBuilder(filePath, { name: LOGO_FILE });
}

/**
 * Carimba o logo como thumbnail do primeiro embed do payload, sem sobrescrever
 * uma thumbnail que já exista. Devolve o mesmo payload, para encadear.
 * @template {{embeds?: Array<{thumbnail?: object}>}} T
 * @param {T} payload
 * @returns {T}
 */
export function brandWithLogo(payload) {
  const first = payload?.embeds?.[0];
  if (first && !first.thumbnail) first.thumbnail = { url: LOGO_URL };
  return payload;
}
