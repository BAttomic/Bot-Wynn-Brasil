// Emojis customizados do servidor (mesmos IDs do bot antigo — mesmo servidor).
// Se algum for recriado, basta atualizar o ID aqui.
export const EMOJI = {
  xp: {
    greenStart: '<:green_start:1267322276076978258>',
    greenMiddle: '<:green_middle:1267322274936127591>',
    greenEnd: '<:green_end:1267322273493160039>',
    emptyStart: '<:empty_start:1267324455537868840>',
    emptyMiddle: '<:empty_middle:1267322271370973257>',
    emptyEnd: '<:empty_end:1267322268095086612>',
  },
  em: {
    stx: '<:stx:1272474387920195614>',
    le: '<:le:1272470028180000823>',
    eb: '<:eb:1272470078549524546>',
    em: '<:em:1272470102541074442>',
  },
};

// Barra de XP com os emojis customizados (portada do bot antigo).
export function xpBarEmoji(percent) {
  const e = EMOJI.xp;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const total = 10;
  const numGreen = Math.round((p / 100) * (total - 2));
  const numEmpty = total - 2 - numGreen;
  let bar = p < 5 ? e.emptyStart : e.greenStart;
  bar += e.greenMiddle.repeat(numGreen);
  bar += e.emptyMiddle.repeat(numEmpty);
  bar += e.emptyEnd;
  return bar;
}
