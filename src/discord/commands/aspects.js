import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import { listAspects, getAspectRate } from '../../services/aspects.js';

const TOP = 25; // linhas mostradas; os totais sempre somam todo mundo

/** Mesmos cargos de liderança do /forcelink, ou Gerenciar Servidor. */
async function isStaff(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const { params } = await getConfig(interaction.guildId);
  const roles = Array.isArray(params?.voterRoles) ? params.voterRoles : [];
  return roles.some((id) => interaction.member?.roles?.cache?.has(id));
}

/** Formata aspects (podem ser fracionários, ex.: 12,5). */
function fmt(n) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

export default {
  data: new SlashCommandBuilder()
    .setName('aspects')
    .setDescription('(Staff) Aspects gerados e a entregar por guild raid')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((o) => o.setName('user').setDescription('Ver os aspects de um jogador específico').setRequired(false))
    .toJSON(),

  async execute(interaction) {
    if (!(await isStaff(interaction))) {
      return interaction.reply({ content: 'Apenas a staff pode consultar os aspects.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const rate = await getAspectRate(interaction.guildId);
    const all = await listAspects(interaction.guildId);
    const user = interaction.options.getUser('user');

    // Um jogador específico.
    if (user) {
      const link = await collections.members().findOne({ discordId: user.id });
      if (!link) return interaction.editReply(`<@${user.id}> não está vinculado a nenhuma conta.`);
      const a = all.find((x) => x.uuid === link.uuid);
      if (!a) return interaction.editReply(`**${link.username}** ainda não fez nenhuma guild raid.`);
      return interaction.editReply(
        `✨ **${a.username}** — **${fmt(a.pending)}** a entregar\n-# Gerou ${fmt(a.earned)} em ${a.raids} raids · já recebeu ${fmt(a.delivered)} · ${rate}/raid.`,
      );
    }

    if (!all.length) return interaction.editReply('Nenhuma guild raid registrada ainda.');

    // Ordena pelo pendente (o que importa entregar), depois pelo gerado.
    const rows = [...all].sort((x, y) => y.pending - x.pending || y.earned - x.earned);
    const totalEarned = all.reduce((s, r) => s + r.earned, 0);
    const totalPending = all.reduce((s, r) => s + r.pending, 0);

    const lines = rows
      .slice(0, TOP)
      .map((r, i) => `\`${String(i + 1).padStart(2, ' ')}.\` **${r.username}** — ${fmt(r.pending)} a entregar · gerou ${fmt(r.earned)} (${r.raids} raids)`);

    return interaction.editReply({
      embeds: [
        {
          title: '✨ Aspects — guild raids',
          color: 0x9b59b6,
          description: lines.join('\n'),
          fields: [
            {
              name: 'Totais da guilda',
              value: `A entregar: **${fmt(totalPending)}** · Gerado no total: **${fmt(totalEarned)}** (${all.length} membros)`,
            },
          ],
          footer: {
            text:
              (rows.length > TOP ? `Mostrando ${TOP} de ${rows.length} · ` : '') +
              `${rate} aspect por raid · linear (0,5 por membro nosso na party)`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
};
