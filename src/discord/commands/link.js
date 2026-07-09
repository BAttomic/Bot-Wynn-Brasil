import { SlashCommandBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';
import { getConfig } from '../../config/guildConfig.js';

export default {
  data: new SlashCommandBuilder()
    .setName('link')
    .setDescription('Vincula sua conta do WynnCraft ao seu Discord')
    .addStringOption((o) =>
      o.setName('nick').setDescription('Seu nick no WynnCraft').setRequired(true),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const nick = interaction.options.getString('nick', true).trim();

    const player = await wynn.player(nick);
    if (!player || !player.uuid) {
      return interaction.editReply(
        `Não encontrei o jogador **${nick}** na API do WynnCraft. Confira o nick.`,
      );
    }

    const members = collections.members();

    // O UUID já está vinculado a OUTRO Discord?
    const byUuid = await members.findOne({ uuid: player.uuid });
    if (byUuid && byUuid.discordId !== interaction.user.id) {
      return interaction.editReply(
        'Essa conta do WynnCraft já está vinculada a outro usuário. Fale com a staff se for engano.',
      );
    }

    // Este Discord já está vinculado a OUTRO nick?
    const byDiscord = await members.findOne({ discordId: interaction.user.id });
    if (byDiscord && byDiscord.uuid !== player.uuid) {
      return interaction.editReply(
        `Seu Discord já está vinculado a **${byDiscord.username}**. Peça à staff um \`/unlink\` para trocar.`,
      );
    }

    const now = new Date();
    await members.updateOne(
      { uuid: player.uuid },
      {
        $set: {
          uuid: player.uuid,
          discordId: interaction.user.id,
          username: player.username,
          inGuild: !!player.guild?.prefix,
          guildRank: player.guild?.rank ?? null,
        },
        $setOnInsert: { linkedAt: now, communitySince: now, guildWars: 0 },
      },
      { upsert: true },
    );

    // Dá o cargo de comunidade, se configurado.
    const cfg = await getConfig(interaction.guildId);
    const communityRoleId = cfg.roles?.community;
    let roleNote = '';
    if (communityRoleId && interaction.member?.roles?.add) {
      await interaction.member.roles.add(communityRoleId).catch(() => {});
      roleNote = ' Acesso à comunidade liberado.';
    }

    return interaction.editReply(
      `Conta **${player.username}** vinculada com sucesso!${roleNote}`,
    );
  },
};
