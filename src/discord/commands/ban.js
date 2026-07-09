import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';
import { getConfig } from '../../config/guildConfig.js';
import { applyClassificationRoles } from '../../services/registration.js';
import { findBan, recordBan, removeBan, listBans, countBans } from '../../services/bans.js';
import { audit } from '../../services/audit.js';

const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>` : '—');

// Resolve um alvo a partir do usuário do Discord e/ou do nick, nesta ordem:
// vínculo no banco, depois a API do WynnCraft.
async function resolveTarget({ user, nick }) {
  if (user) {
    const linked = await collections.members().findOne({ discordId: user.id });
    if (linked) return { uuid: linked.uuid, username: linked.username, discordId: user.id };
  }
  if (nick) {
    const player = await wynn.player(nick).catch(() => null);
    if (player?.uuid) {
      return { uuid: player.uuid, username: player.username, discordId: user?.id ?? null };
    }
    return null;
  }
  // Usuário sem vínculo e sem nick: só dá para banir pelo Discord se já houver
  // um registro anterior que carregue o uuid.
  if (user) {
    const prior = await findBan({ discordId: user.id });
    if (prior) return { uuid: prior.uuid, username: prior.usernames?.[0] ?? null, discordId: user.id };
  }
  return null;
}

export default {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('(Staff) Lista de banimentos permanentes')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Bane um jogador (por Discord, nick, ou ambos)')
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false))
        .addStringOption((o) => o.setName('motivo').setDescription('Motivo do banimento').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove o banimento (por Discord ou nick)')
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false)),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Mostra a lista de banidos'))
    .addSubcommand((s) =>
      s
        .setName('check')
        .setDescription('Verifica se alguém está banido')
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false)),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const user = interaction.options.getUser('user');
    const nick = interaction.options.getString('nick');

    if (sub === 'list') {
      const [bans, total] = await Promise.all([listBans(25), countBans()]);
      if (!bans.length) return interaction.editReply('Nenhum banimento registrado.');
      const lines = bans.map((b) => {
        const nicks = (b.usernames || []).join(', ') || '`?`';
        const discords = (b.discordIds || []).map((id) => `<@${id}>`).join(', ') || '—';
        return `• **${nicks}** — ${discords}\n  \`${b.uuid}\` · ${ts(b.firstBannedAt)} · *${b.reason}*`;
      });
      return interaction.editReply({
        embeds: [{
          title: `🚫 Banidos (${total})`,
          description: lines.join('\n').slice(0, 4000),
          color: 0xe74c3c,
          footer: { text: total > bans.length ? `Mostrando ${bans.length} de ${total}` : 'Lista completa' },
        }],
      });
    }

    if (sub === 'check') {
      if (!user && !nick) return interaction.editReply('Informe `user` ou `nick`.');
      let uuid = null;
      if (nick) uuid = (await wynn.player(nick).catch(() => null))?.uuid ?? null;
      const ban = await findBan({ uuid, discordId: user?.id ?? null });
      if (!ban) return interaction.editReply('✅ Não está na lista de banidos.');
      return interaction.editReply(
        `🚫 **Banido.**\nUUID: \`${ban.uuid}\`\nNicks: ${(ban.usernames || []).join(', ') || '?'}\nDiscords: ${(ban.discordIds || []).map((id) => `<@${id}>`).join(', ') || '—'}\nMotivo: *${ban.reason}*\nDesde: ${ts(ban.firstBannedAt)}`,
      );
    }

    if (!user && !nick) return interaction.editReply('Informe `user`, `nick`, ou os dois.');

    if (sub === 'remove') {
      let uuid = null;
      if (nick) uuid = (await wynn.player(nick).catch(() => null))?.uuid ?? null;
      const removed = await removeBan({ uuid, discordId: user?.id ?? null });
      if (!removed) return interaction.editReply('Nenhum banimento encontrado para esse alvo.');
      audit(interaction.client, interaction.guildId, `♻️ <@${interaction.user.id}> removeu ${removed} banimento(s).`);
      return interaction.editReply(`Banimento removido (${removed} registro(s)). O cargo volta no próximo sync de cargos.`);
    }

    // add
    const target = await resolveTarget({ user, nick });
    if (!target) {
      return interaction.editReply(
        'Não consegui identificar a conta. Informe um `nick` válido do WynnCraft, ou um `user` já vinculado.',
      );
    }

    const motivo = interaction.options.getString('motivo') ?? 'Banido pela staff';
    await recordBan({ ...target, reason: motivo, by: interaction.user.id });

    // Aplica o cargo já, se a pessoa estiver no servidor.
    let aplicado = false;
    if (target.discordId) {
      const member = await interaction.guild.members.fetch(target.discordId).catch(() => null);
      if (member) {
        const cfg = await getConfig(interaction.guildId);
        await applyClassificationRoles(member, cfg, 'banned');
        aplicado = true;
      }
    }

    audit(interaction.client, interaction.guildId, `🚫 <@${interaction.user.id}> baniu **${target.username ?? target.uuid}**.`);
    return interaction.editReply(
      `Banido: **${target.username ?? target.uuid}**\nUUID: \`${target.uuid}\`\nDiscord: ${target.discordId ? `<@${target.discordId}>` : '— (só a conta do jogo)'}\nMotivo: *${motivo}*\n${aplicado ? 'Cargo aplicado agora.' : 'Cargo será aplicado quando essa pessoa entrar/registrar.'}`,
    );
  },
};
