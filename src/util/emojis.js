import { optional } from '../config/env.js';

// Emojis customizados do servidor. Os antigos (green_start, stx, le, …) foram
// apagados, e um emoji inexistente aparece como texto cru no Discord.
//
// Agora cada um vem do ambiente e tem um fallback em Unicode que sempre
// renderiza. Para usar os customizados, defina a string COMPLETA, ex.:
//   EMOJI_LIQUID_EMERALD=<:LiquidEmerald:1272470028180000823>
//
// Lido preguiçosamente: loadEnv() roda depois da avaliação dos imports.
function e(name, fallback) {
  return optional(`EMOJI_${name}`) || fallback;
}

/** Emojis do servidor. Sobrescreva pelo ambiente se algum for recriado. */
const DEFAULTS = {
  LIQUID_EMERALD: '<:LiquidEmerald:1328487792950644897>',
  EMERALD_BLOCK: '<:EmeraldBlock:1328487765238747136>',
  EMERALD: '<:Emerald:1328487728765079555>',
  // A barra de XP não tem emoji customizado; quadrados Unicode sempre renderizam.
  BAR_FULL: '🟩',
  BAR_EMPTY: '⬛',
};

/**
 * @typedef {{ stx: string, le: string, eb: string, em: string }} EmeraldEmojis
 * @typedef {{ full: string, empty: string }} BarEmojis
 */
export const EMOJI = {
  /** @returns {EmeraldEmojis} stx e le compartilham o Liquid Emerald, como no servidor. */
  get em() {
    const liquid = e('LIQUID_EMERALD', DEFAULTS.LIQUID_EMERALD);
    return {
      stx: liquid,
      le: liquid,
      eb: e('EMERALD_BLOCK', DEFAULTS.EMERALD_BLOCK),
      em: e('EMERALD', DEFAULTS.EMERALD),
    };
  },
  /** @returns {BarEmojis} */
  get bar() {
    return {
      full: e('BAR_FULL', DEFAULTS.BAR_FULL),
      empty: e('BAR_EMPTY', DEFAULTS.BAR_EMPTY),
    };
  },
};

const BAR_SEGMENTS = 10;

// Barra de XP. Sem emojis customizados, cai em quadrados Unicode.
export function xpBarEmoji(percent) {
  const { full, empty } = EMOJI.bar;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((p / 100) * BAR_SEGMENTS);
  return full.repeat(filled) + empty.repeat(BAR_SEGMENTS - filled);
}
