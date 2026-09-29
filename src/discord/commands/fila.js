import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { QUEUE_PREFIX, buildQueuePanel, handleQueuePanel } from '../../services/recruitQueuePanel.js';
import { LEVEL, hasLevel, deniedMessage } from '../../services/permissions.js';

/**
 * Quem pode mexer na fila: qualquer cargo da Staff (ver services/permissions.js).
 * Mesma regra do /reconciliar — quem decide entrada é a mesma gente.
 */
async function isStaff(interaction) {
  return hasLevel(interaction.member, LEVEL.STAFF);
}

export default {
  data: new SlashCommandBuilder()
    .setName('fila')
    .setDescription('(Staff) Fila de entrada: quem foi aprovado e ainda não entrou na guilda')
    .setDefaultMemberPermissions(0)
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith(QUEUE_PREFIX);
  },

  async handleComponent(interaction) {
    return handleQueuePanel(interaction, { isStaff: await isStaff(interaction) });
  },

  async execute(interaction) {
    // Efêmero: a fila é trabalho de bastidor, e o painel tem botão que fecha
    // candidatura. O /verificar continua mostrando a fila para leitura.
    await interaction.deferReply({ ephemeral: true });
    if (!(await isStaff(interaction))) return interaction.editReply('Apenas staff pode abrir a fila de entrada.');
    return interaction.editReply(await buildQueuePanel({}));
  },
};
