import { SlashCommandBuilder } from 'discord.js';
import { EMOJI } from '../../util/emojis.js';

const STX = 64 * 64 * 64; // 262144
const LE = 64 * 64; // 4096
const EB = 64;

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
    const n = parseFloat(raw) || 0;
    let em = n;
    if (raw.endsWith('stx')) em = n * STX;
    else if (raw.endsWith('le')) em = n * LE;
    else if (raw.endsWith('eb')) em = n * EB;
    // "em" ou número puro = esmeraldas

    em = Math.floor(em);
    const frac = {
      stx: Math.floor(em / STX),
      le: Math.floor((em % STX) / LE),
      eb: Math.floor((em % LE) / EB),
      em: em % EB,
    };
    const market = Math.floor(em * 1.05);

    await interaction.reply({
      embeds: [
        {
          title: 'Conversor de Esmeraldas',
          color: 0x2ecc71,
          description:
`**Entrada:** \`${raw}\` = **${em}** ${EMOJI.em.em}

**Fracionado:** ${EMOJI.em.stx} \`${frac.stx}\` · ${EMOJI.em.le} \`${frac.le}\` · ${EMOJI.em.eb} \`${frac.eb}\` · ${EMOJI.em.em} \`${frac.em}\`

**Equivalências:**
- ${EMOJI.em.stx} \`${(em / STX).toFixed(2)}\`
- ${EMOJI.em.le} \`${(em / LE).toFixed(2)}\`
- ${EMOJI.em.eb} \`${(em / EB).toFixed(2)}\`
- ${EMOJI.em.em} \`${em}\`

**TradeMarket (+5% taxa):** ${EMOJI.em.em} \`${market}\` ( ${EMOJI.em.le} \`${(market / LE).toFixed(2)}\` )`,
        },
      ],
    });
  },
};
