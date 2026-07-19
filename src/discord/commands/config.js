import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import {
  getConfig,
  setChannel,
  setRole,
  setParam,
  CHANNEL_KEYS,
  ROLE_KEYS,
  PARAM_KEYS,
} from '../../config/guildConfig.js';
import { recomputePoints, rebuildLeaderboards } from '../../services/points.js';
import { ensurePanels } from '../../services/registration.js';
import { ensureStaticPanels } from '../../services/staticPanels.js';
import { ensurePingRolePanels } from '../../services/pingRoles.js';
import { ensureLeaderboardPanel } from '../../services/leaderboardPanel.js';

// Canais que hospedam uma mensagem fixa mantida pelo bot.
const PANEL_CHANNEL_KEYS = new Set([
  'registration',
  'rules',
  'pings',
  'recruiters',
  'warApplication',
  'tome',
  'loans',
  'panel',
]);

function choices(keys) {
  return keys.map((k) => ({ name: k, value: k }));
}

export default {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configuração do bot da guilda')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Define um canal')
        .addStringOption((o) =>
          o.setName('key').setDescription('Chave do canal').setRequired(true).addChoices(...choices(CHANNEL_KEYS)),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Canal').addChannelTypes(ChannelType.GuildText).setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('role')
        .setDescription('Define um cargo')
        .addStringOption((o) =>
          o.setName('key').setDescription('Chave do cargo').setRequired(true).addChoices(...choices(ROLE_KEYS)),
        )
        .addRoleOption((o) => o.setName('role').setDescription('Cargo').setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName('param')
        .setDescription('Define um parâmetro')
        .addStringOption((o) =>
          o.setName('key').setDescription('Chave do parâmetro').setRequired(true).addChoices(...choices(PARAM_KEYS)),
        )
        .addStringOption((o) =>
          o.setName('value').setDescription('Valor (texto, número ou JSON)').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('show').setDescription('Mostra a configuração atual'))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;

    if (sub === 'channel') {
      const key = interaction.options.getString('key', true);
      const ch = interaction.options.getChannel('channel', true);
      await setChannel(gid, key, ch.id);

      // Estes canais vivem de uma mensagem fixa; publica já, sem esperar o job.
      if (PANEL_CHANNEL_KEYS.has(key)) {
        await ensurePanels(interaction.client, gid);
        await ensureStaticPanels(interaction.client, gid);
        await ensurePingRolePanels(interaction.client, gid);
        await ensureLeaderboardPanel(interaction.client, gid);
        return interaction.editReply(`Canal **${key}** definido para <#${ch.id}>. Painel publicado.`);
      }
      return interaction.editReply(`Canal **${key}** definido para <#${ch.id}>.`);
    }

    if (sub === 'role') {
      const key = interaction.options.getString('key', true);
      const role = interaction.options.getRole('role', true);
      await setRole(gid, key, role.id);
      return interaction.editReply(`Cargo **${key}** definido para <@&${role.id}>.`);
    }

    if (sub === 'param') {
      const key = interaction.options.getString('key', true);
      const raw = interaction.options.getString('value', true);
      let value = raw;
      if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
      else if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
          value = JSON.parse(raw);
        } catch {
          /* mantém como texto */
        }
      }
      await setParam(gid, key, value);

      // Os pontos são derivados do histórico, então mexer num peso reescreve
      // todo o passado. Fazemos na hora para o /config nunca mentir.
      if (key === 'pointsWeights' || key === 'territoryMultiplierCap') {
        const { members } = await recomputePoints();
        await rebuildLeaderboards();
        return interaction.editReply(
          `Parâmetro **${key}** = \`${JSON.stringify(value)}\`.\nHistórico reprocessado: **${members}** membro(s), ranking refeito.`,
        );
      }
      return interaction.editReply(`Parâmetro **${key}** = \`${JSON.stringify(value)}\`.`);
    }

    // show
    const cfg = await getConfig(gid);
    const fmt = (obj, render) => {
      const entries = Object.entries(obj || {});
      return entries.length ? entries.map(render).join('\n') : '—';
    };
    return interaction.editReply({
      embeds: [
        {
          title: 'Configuração atual',
          color: 0x2ecc71,
          fields: [
            { name: 'Canais', value: fmt(cfg.channels, ([k, v]) => `• **${k}**: <#${v}>`) },
            { name: 'Cargos', value: fmt(cfg.roles, ([k, v]) => `• **${k}**: <@&${v}>`) },
            {
              name: 'Parâmetros',
              value: fmt(cfg.params, ([k, v]) => `• **${k}**: \`${JSON.stringify(v)}\``),
            },
          ],
        },
      ],
    });
  },
};
