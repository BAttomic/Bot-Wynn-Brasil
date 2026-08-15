/**
 * O bot fala português. A exceção é o REGISTRO: quem chega de fora precisa
 * conseguir entrar antes de saber o idioma do servidor, e um painel que ninguém
 * entende é uma porta trancada.
 *
 * Nada de framework nem de catálogo de chaves — as duas dependências do projeto
 * são discord.js e mongodb, e um `t()` com arquivos de tradução seria maior que
 * o problema. Cada texto bilíngue fica no lugar onde já estava, como um par
 * `{ pt, en }`.
 *
 * A escolha vem do idioma que a pessoa configurou no PRÓPRIO Discord
 * (`interaction.locale`), não do servidor: é o único sinal que temos de quem
 * está lendo, e ele chega de graça em toda interação.
 */

/** @param {{locale?: string}} interaction */
export function isEnglish(interaction) {
  return String(interaction?.locale ?? '').toLowerCase().startsWith('en');
}

/**
 * @template T
 * @param {{locale?: string}} interaction
 * @param {{pt: T, en: T}} texts
 * @returns {T}
 */
export function pick(interaction, { pt, en }) {
  return isEnglish(interaction) ? en : pt;
}
