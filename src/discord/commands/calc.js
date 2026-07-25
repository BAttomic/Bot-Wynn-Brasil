import { SlashCommandBuilder } from 'discord.js';
import { EMOJI } from '../../util/emojis.js';

const STX = 64 * 64 * 64; // 262144
const LE = 64 * 64; // 4096
const EB = 64;

const MARKET_FEE = 0.05; // taxa de 5% do TradeMarket

function parseEmeralds(raw) {
  const n = parseFloat(raw) || 0;
  if (raw.endsWith('stx')) return n * STX;
  if (raw.endsWith('le')) return n * LE;
  if (raw.endsWith('eb')) return n * EB;
  return n; // "em" ou número puro
}

// Quebra um total de esmeraldas em stx / le / eb / em.
function split(total) {
  return {
    stx: Math.floor(total / STX),
    le: Math.floor((total % STX) / LE),
    eb: Math.floor((total % LE) / EB),
    em: total % EB,
  };
}

function fracLine(total) {
  const f = split(total);
  const e = EMOJI.em;
  return `${e.stx} \`${f.stx}\` · ${e.le} \`${f.le}\` · ${e.eb} \`${f.eb}\` · ${e.em} \`${f.em}\``;
}

export default {
  data: new SlashCommandBuilder()
    .setName('calc')
    .setDescription('Conversor de esmeraldas (stx/le/eb/em)')
    .addStringOption((o) =>
      o.setName('valor').setDescription('Ex.: 3stx, 10le, 500eb, 1000em').setRequired(true),
    )
    .toJSON(),

  async execute(interaction) {
    const raw = interaction.options.getString('valor', true).toLowerCase().trim();
    const em = Math.floor(parseEmeralds(raw));
    const market = Math.floor(em * (1 + MARKET_FEE));
    const e = EMOJI.em;

    await interaction.reply({
      embeds: [
        {
          title: 'Conversor de Esmeraldas',
          color: 0x2ecc71,
          description:
`**Entrada:** \`${raw}\` = **${em.toLocaleString('pt-BR')}** ${e.em}

**Fracionado:** ${fracLine(em)}

**Equivalências:**
- ${e.stx} \`${(em / STX).toFixed(2)}\` stx
- ${e.le} \`${(em / LE).toFixed(2)}\` le
- ${e.eb} \`${(em / EB).toFixed(2)}\` eb
- ${e.em} \`${em}\` em

**TradeMarket (+5% de taxa):** **${market.toLocaleString('pt-BR')}** ${e.em}
${fracLine(market)}`,
        },
      ],
    });
  },
};
