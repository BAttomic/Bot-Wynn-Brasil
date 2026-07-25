import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { getConfig } from '../../config/guildConfig.js';
import { forceLink } from '../../services/registration.js';

/**
 * Quem pode forçar um vínculo: os mesmos cargos de liderança que votam nas
 * candidaturas (`params.voterRoles`), ou qualquer um com Gerenciar Servidor.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<boolean>}
 */
async function canForceLink(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const { params } = await getConfig(interaction.guildId);
  const roles = Array.isArray(params?.voterRoles) ? params.voterRoles : [];
  return roles.some((id) => interaction.member?.roles?.cache?.has(id));
}

export default {
  data: new SlashCommandBuilder()
    .setName('forcelink')
    .setDescription('(Staff) Vincula à força um usuário a uma conta do WynnCraft')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(true))
    .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(true))
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!(await canForceLink(interaction))) {
      return interaction.editReply('Você não tem permissão para forçar vínculos.');
    }

    const targetUser = interaction.options.getUser('user', true);
    if (targetUser.bot) return interaction.editReply('Não dá para vincular um bot.');

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const nick = interaction.options.getString('nick', true);

    const result = await forceLink({ interaction, targetUser, targetMember, rawNick: nick });
    return interaction.editReply(result);
  },
};
