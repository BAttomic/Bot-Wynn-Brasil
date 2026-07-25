import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import {
  computeReconciliation,
  reconciliationPanel,
  applyReconciliation,
} from '../../services/reconciliation.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

const APPLY_SCOPES = new Set(['member', 'neutral', 'banned', 'all']);

/**
 * Quem pode usar o painel: os mesmos cargos de liderança do /forcelink
 * (`params.voterRoles`), ou qualquer um com Gerenciar Servidor.
 */
async function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const { params } = await getConfig(interaction.guildId);
  const roles = Array.isArray(params?.voterRoles) ? params.voterRoles : [];
  return roles.some((id) => interaction.member?.roles?.cache?.has(id));
}

export default {
  data: new SlashCommandBuilder()
    .setName('reconciliar')
    .setDescription('(Staff) Painel para conferir e corrigir os cargos de classificação de todo o servidor')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('recon:');
  },

  async handleComponent(interaction) {
    if (!(await isStaff(interaction))) {
      return interaction.reply({ content: 'Apenas a staff pode usar este painel.', ephemeral: true });
    }
    const [, action, scope] = interaction.customId.split(':');

    if (action === 'refresh') {
      await interaction.deferUpdate();
      const data = await computeReconciliation(interaction.guild);
      if (!data) return interaction.editReply({ content: 'Não consegui obter os dados da guilda.', embeds: [], components: [] });
      return interaction.editReply(reconciliationPanel(data));
    }

    // Seleção de indivíduos: aplica cada um com a classificação recomputada.
    if (action === 'select') {
      await interaction.deferUpdate();
      const { applied, data } = await applyReconciliation(interaction.guild, 'all', interaction.values);
      audit(interaction.client, interaction.guildId, `🔧 <@${interaction.user.id}> reconciliou **${applied}** cargo(s) (seleção).`);
      return interaction.editReply(reconciliationPanel(data, note(applied)));
    }

    // Botões de grupo.
    if (action === 'apply' && APPLY_SCOPES.has(scope)) {
      await interaction.deferUpdate();
      const { applied, data } = await applyReconciliation(interaction.guild, scope);
      audit(interaction.client, interaction.guildId, `🔧 <@${interaction.user.id}> reconciliou **${applied}** cargo(s) (${scope}).`);
      return interaction.editReply(reconciliationPanel(data, note(applied)));
    }
  },

  async execute(interaction) {
    if (!(await isStaff(interaction))) {
      return interaction.reply({ content: 'Apenas a staff pode usar este comando.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const data = await computeReconciliation(interaction.guild);
    if (!data) return interaction.editReply('Não consegui obter os dados da guilda (confira `WYNN_GUILD_PREFIX`).');
    return interaction.editReply(reconciliationPanel(data));
  },
};

function note(applied) {
  return applied
    ? `✅ **${applied}** cargo(s) aplicado(s). Retrato atualizado abaixo.`
    : 'Nada a aplicar — ninguém elegível na seleção.';
}
