import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';
import { getConfig } from '../../config/guildConfig.js';
import { applyClassificationRoles } from '../../services/registration.js';
import {
  findExemption,
  resolveIdentity,
  banPerson,
  unbanPerson,
  banNicks,
  listBans,
  countBans,
  countExemptions,
} from '../../services/bans.js';
import { audit } from '../../services/audit.js';

const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>` : '—');

/**
 * O ponto de partida: o Discord informado e/ou a conta do nick. O resto da
 * pessoa (outras contas, outros Discords) sai de resolveIdentity, em bans.js.
 * @returns {Promise<{uuid: string|null, username: string|null, discordId: string|null}|null>}
 *   null = o nick informado não existe no WynnCraft
 */
async function seedFrom({ user, nick }) {
  const seed = { uuid: null, username: null, discordId: user?.id ?? null };
  if (nick) {
    const player = await wynn.player(nick).catch(() => null);
    if (!player?.uuid) return null;
    seed.uuid = player.uuid;
    seed.username = player.username;
  }
  return seed;
}

/** "Fulano, Ciclano" para as contas e "<@a>, <@b>" para os Discords da pessoa. */
function describePerson(p) {
  const nicks = p.uuids.map((u) => p.nomes.get(u) ?? `\`${u}\``).join(', ') || '?';
  const discords = p.discordIds.map((id) => `<@${id}>`).join(', ') || '— (nenhum Discord ligado)';
  return { nicks, discords };
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
      const [bans, total, isentos] = await Promise.all([listBans(25), countBans(), countExemptions()]);
      const rodape = isentos ? ` · ${isentos} isento(s) por decisão da staff` : '';
      if (!bans.length) {
        return interaction.editReply(`Nenhum banimento ativo.${isentos ? ` (${isentos} isento(s) na lista.)` : ''}`);
      }
      const lines = bans.map((b) => {
        const nicks = banNicks(b).join(', ') || '`?`';
        const discords = (b.discordIds || []).map((id) => `<@${id}>`).join(', ') || '—';
        return `• **${nicks}** — ${discords}\n  \`${b.uuid}\` · ${ts(b.firstBannedAt)} · *${b.reason}*`;
      });
      return interaction.editReply({
        embeds: [{
          title: `🚫 Banidos (${total})`,
          description: lines.join('\n').slice(0, 4000),
          color: 0xe74c3c,
          footer: { text: `${total > bans.length ? `Mostrando ${bans.length} de ${total}` : 'Lista completa'}${rodape}` },
        }],
      });
    }

    if (sub === 'check') {
      if (!user && !nick) return interaction.editReply('Informe `user` ou `nick`.');
      const seed = await seedFrom({ user, nick });
      if (!seed) return interaction.editReply('Esse nick não existe no WynnCraft.');
      const pessoa = await resolveIdentity({ ...seed, viaBans: true });
      const ids = { uuids: pessoa.uuids, discordIds: pessoa.discordIds };
      const bans = await collections
        .bans()
        .find({ $or: [{ uuid: { $in: ids.uuids } }, { discordIds: { $in: ids.discordIds } }], exempt: { $ne: true } })
        .toArray();
      const ban = bans[0] ?? null;
      if (!ban) {
        // Distinguir "nunca foi banido" de "foi isento" evita a staff achar que
        // o /ban remove não pegou e sair banindo de novo à mão.
        const ex = await findExemption(ids);
        if (ex) {
          return interaction.editReply(
            `✅ Não está banido — **isento pela staff** ${ts(ex.exemptAt)}${ex.exemptBy ? ` por <@${ex.exemptBy}>` : ''}.\nMotivo do banimento original: *${ex.reason}*\n-# A regra automática da GsW não volta a banir. Só \`/ban add\` derruba a isenção.`,
          );
        }
        return interaction.editReply('✅ Não está na lista de banidos.');
      }
      return interaction.editReply(
        `🚫 **Banido.**\nContas: ${bans.map((b) => banNicks(b)[0] ?? `\`${b.uuid}\``).join(', ')}\nDiscords: ${[...new Set(bans.flatMap((b) => b.discordIds || []))].map((id) => `<@${id}>`).join(', ') || '—'}\nMotivo: *${ban.reason}*\nDesde: ${ts(ban.firstBannedAt)}`,
      );
    }

    if (!user && !nick) return interaction.editReply('Informe `user`, `nick`, ou os dois.');

    if (sub === 'remove') {
      const seed = await seedFrom({ user, nick });
      if (!seed) return interaction.editReply('Esse nick não existe no WynnCraft.');
      const res = await unbanPerson({ ...seed, by: interaction.user.id });
      if (!res.removed) return interaction.editReply('Nenhum banimento encontrado para essa pessoa.');
      const { nicks, discords } = describePerson(res);
      audit(interaction.client, interaction.guildId, `♻️ <@${interaction.user.id}> removeu o banimento de **${nicks}** (${res.removed} registro(s)) — isenção permanente gravada.`);
      return interaction.editReply({
        content: `Banimento removido de **${nicks}** (${res.removed} registro(s)).\nDiscords: ${discords}\nO cargo volta no próximo sync de cargos.\n-# Fica gravado como **isenção**: mesmo continuando na GsW, o bot não bane essa pessoa de novo sozinho. Para rebanir, use \`/ban add\`.`,
        allowedMentions: { parse: [] },
      });
    }

    // add — a PESSOA inteira: todas as contas e todos os Discords ligados ao alvo.
    const seed = await seedFrom({ user, nick });
    if (!seed) return interaction.editReply('Esse nick não existe no WynnCraft.');

    const motivo = interaction.options.getString('motivo') ?? 'Banido pela staff';
    // Ban da staff é explícito e vence a isenção — o contrário deixaria um alvo
    // isento imune até a alguém da staff.
    const pessoa = await banPerson({ ...seed, reason: motivo, by: interaction.user.id, override: true });
    if (!pessoa) {
      return interaction.editReply(
        'Não achei nenhuma conta do WynnCraft dessa pessoa. Informe também o `nick` — o banimento é indexado pela conta do jogo.',
      );
    }

    // Aplica o cargo já, em todo Discord da pessoa que estiver no servidor.
    const cfg = await getConfig(interaction.guildId);
    let aplicados = 0;
    for (const id of pessoa.discordIds) {
      const member = await interaction.guild.members.fetch(id).catch(() => null);
      if (!member) continue;
      await applyClassificationRoles(member, cfg, 'banned');
      aplicados += 1;
    }

    const { nicks, discords } = describePerson(pessoa);
    audit(interaction.client, interaction.guildId, `🚫 <@${interaction.user.id}> baniu **${nicks}**.`);
    return interaction.editReply({
      content: `Banido: **${nicks}**\nDiscords: ${discords}\nMotivo: *${motivo}*\n${aplicados ? `Cargo aplicado agora em ${aplicados} Discord(s).` : 'Cargo será aplicado quando essa pessoa entrar/registrar.'}${pessoa.hadExemption ? '\n-# A isenção anterior foi derrubada por este banimento.' : ''}`,
      allowedMentions: { parse: [] },
    });
  },
};
