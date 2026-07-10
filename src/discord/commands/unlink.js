import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig, ROLE_KEYS } from '../../config/guildConfig.js';
import { isBanned } from '../../services/bans.js';
import { audit } from '../../services/audit.js';

/**
 * Cargos que o /unlink NUNCA remove.
 *
 * Tirar o cargo de banido de alguém que continua na lista de banimentos
 * devolveria o acesso ao servidor inteiro — o oposto do que se quer ao
 * desvincular. Se a intenção é desbanir, o comando é /ban remove.
 * @type {readonly string[]}
 */
const KEEP_IF_BANNED = Object.freeze(['banned']);

/** @param {string} s @returns {string} */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove do membro todos os cargos que o bot administra.
 * @param {import('discord.js').GuildMember} member
 * @param {import('../../config/guildConfig.js').GuildConfig} cfg
 * @param {boolean} keepBanned
 * @returns {Promise<number>} quantos cargos saíram
 */
async function stripManagedRoles(member, cfg, keepBanned) {
  const keys = ROLE_KEYS.filter((k) => !(keepBanned && KEEP_IF_BANNED.includes(k)));
  const ids = keys.map((k) => cfg.roles?.[k]).filter(Boolean);

  let removed = 0;
  for (const id of ids) {
    if (!member.roles.cache.has(id)) continue;
    const ok = await member.roles.remove(id).then(() => true).catch(() => false);
    if (ok) removed += 1;
  }
  return removed;
}

export default {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('(Staff) Remove o vínculo de um usuário e seus cargos')
    .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
    .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false))
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

    // Precisamos do documento ANTES de apagar: é dele que sai o discordId de
    // quem foi buscado por nick.
    const doc = await collections.members().findOne(filter);
    if (!doc) return interaction.editReply('Nenhum vínculo encontrado.');

    await collections.members().deleteOne({ _id: doc._id });

    const cfg = await getConfig(interaction.guildId);
    const banned = await isBanned({ uuid: doc.uuid, discordId: doc.discordId });

    let removed = 0;
    const member = await interaction.guild.members.fetch(doc.discordId).catch(() => null);
    if (member) removed = await stripManagedRoles(member, cfg, banned);

    audit(
      interaction.client,
      interaction.guildId,
      `🔓 <@${interaction.user.id}> desvinculou **${doc.username}** (<@${doc.discordId}>) — ${removed} cargo(s) removido(s).`,
    );

    const nota = !member
      ? ' O usuário não está mais no servidor, então nenhum cargo foi tocado.'
      : banned
        ? ' O cargo de banido foi **mantido**, porque essa conta continua na lista de banimentos. Use `/ban remove` para desbanir.'
        : '';

    return interaction.editReply(
      `Vínculo de **${doc.username}** removido. ${removed} cargo(s) retirado(s).${nota}`,
    );
  },
};
