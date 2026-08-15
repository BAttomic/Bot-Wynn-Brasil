/**
 * Faz a resposta EFÊMERA se apagar sozinha depois de alguns segundos.
 *
 * Efêmera não polui o canal — ninguém além de quem clicou a vê —, mas ela também
 * não vai embora sozinha: fica empilhada no cliente até a pessoa dispensar uma a
 * uma. Entregando recompensa para vinte pessoas, quem entrega termina com dezenas
 * de "entregue a fulano" na tela. É esse acúmulo que isto resolve.
 *
 * Três limites, todos aceitáveis para uma confirmação descartável:
 *
 *  1. só funciona dentro dos 15 minutos do token da interação — de sobra para um
 *     timer de segundos;
 *  2. o timer não sobrevive a um restart do bot; a mensagem que escapar fica, e
 *     a pessoa dispensa à mão como fazia antes;
 *  3. quem estiver LENDO na hora vê sumir. Por isso o padrão é generoso, e nada
 *     que a pessoa precise guardar deve passar por aqui — o registro permanente
 *     é o painel de histórico.
 *
 * O erro é engolido de propósito: a pessoa pode ter dispensado antes, e "não
 * consegui apagar o que já não existe" não é problema de ninguém.
 *
 * @param {import('discord.js').BaseInteraction} interaction
 * @param {number} [seconds]
 */
export function autoDismiss(interaction, seconds = 15) {
  const timer = setTimeout(() => {
    // O caso comum de falha é a pessoa já ter dispensado a mensagem — não é
    // problema de ninguém, e logar isso seria ruído a cada entrega.
    interaction.deleteReply().catch(() => {});
  }, seconds * 1000);
  // O processo não pode ficar de pé só por causa de uma confirmação descartável.
  timer.unref?.();
  return timer;
}

/** Segundos padrão por tipo de mensagem. */
export const DISMISS = Object.freeze({
  // Confirmação de quem entregou: curta, ela já cumpriu o papel ao ser lida.
  delivery: 15,
  // Confirmação de membro (entrou/saiu da fila): um pouco mais, o texto explica
  // regras (dias de guilda, missão semanal) que a pessoa pode querer reler.
  member: 30,
});
