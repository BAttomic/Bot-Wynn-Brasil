import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('(Staff) Remove o vínculo de um usuário')
    .addUserOption((o) =>
      o.setName('user').setDescription('Usuário do Discord').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('user');
    const nick = interaction.options.getString('nick');
    if (!user && !nick) {
      return interaction.editReply('Informe um usuário (`user`) ou um nick (`nick`).');
    }
    const filter = user
      ? { discordId: user.id }
      : { username: new RegExp(`^${escapeRegex(nick)}$`, 'i') };
    const res = await collections.members().deleteOne(filter);
    return interaction.editReply(
      res.deletedCount ? 'Vínculo removido.' : 'Nenhum vínculo encontrado.',
    );
  },
};
