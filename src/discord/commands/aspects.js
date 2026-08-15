import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { getConfig } from '../../config/guildConfig.js';
import {
  listAspects,
  getAspectRate,
  setAspectsDelivered,
  adjustAspectsDelivered,
} from '../../services/aspects.js';
import { minGuildDays } from '../../services/eligibility.js';
import { audit } from '../../services/audit.js';
import { ensureTomePanel } from '../../services/tomes.js';

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
    // Correção de entrega digitada errada. Vivem como OPÇÕES do /aspects, e não
    // como subcomando, para o `/aspects` puro continuar funcionando como sempre.
    //
    // Duas formas porque as duas situações são diferentes: `estornar` para
    // desfazer UMA entrega errada (não precisa saber o acumulado) e `entregues`
    // para reescrever o total quando se sabe o número certo.
    .addNumberOption((o) =>
      o
        .setName('estornar')
        .setDescription('(Corrige) Quanto entregou A MAIS. Ex.: digitou 20 e eram 2 → 18. Exige "user".')
        .setRequired(false),
    )
    .addNumberOption((o) =>
      o
        .setName('entregues')
        .setDescription('(Corrige) Novo TOTAL já entregue a esse jogador. Exige "user".')
        .setMinValue(0)
        .setRequired(false),
    )
    .toJSON(),

  async execute(interaction) {
    if (!(await isStaff(interaction))) {
      return interaction.reply({ content: 'Apenas a staff pode consultar os aspects.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const rate = await getAspectRate(interaction.guildId);
    const min = await minGuildDays(interaction.guildId);
    const all = await listAspects(interaction.guildId);
    const user = interaction.options.getUser('user');

    const corrigir = interaction.options.getNumber('entregues');
    const estornar = interaction.options.getNumber('estornar');
    if (corrigir !== null && estornar !== null) {
      return interaction.editReply(
        'Use **uma** das duas: `estornar` (quanto passou a mais) ou `entregues` (o total certo).',
      );
    }
    if ((corrigir !== null || estornar !== null) && !user) {
      return interaction.editReply(
        'Para corrigir, informe também o **user**:\n' +
          '• `/aspects user:@fulano estornar:18` — tira 18 do que já foi entregue\n' +
          '• `/aspects user:@fulano entregues:2` — reescreve o total para 2',
      );
    }

    // Um jogador específico.
    if (user) {
      const link = await collections.members().findOne({ discordId: user.id });
      if (!link) return interaction.editReply(`<@${user.id}> não está vinculado a nenhuma conta.`);

      // ---- Correção ----
      if (corrigir !== null || estornar !== null) {
        // `estornar: 18` significa "tira 18", então o sinal é invertido aqui —
        // quem digita não precisa lembrar de pôr o menos.
        const res =
          estornar !== null
            ? await adjustAspectsDelivered(link.uuid, -estornar)
            : await setAspectsDelivered(link.uuid, corrigir);
        if (!res) {
          return interaction.editReply(
            estornar === 0
              ? 'Estornar zero não faz nada. Informe quanto foi entregue a mais.'
              : `**${link.username}** não tem registro em guildStats.`,
          );
        }

        // Relê depois da escrita: `pending` já reflete a correção, inclusive
        // negativo se o total informado passar do que a pessoa gerou.
        const depois = (await listAspects(interaction.guildId)).find((x) => x.uuid === link.uuid);
        const saldo = depois?.pending ?? 0;
        const nota =
          saldo < 0
            ? `\n-# ⚠️ Saldo **negativo**: ${fmt(-saldo)} a mais do que gerou. As próximas raids quitam isso antes de render aspect de novo.`
            : '';

        await audit(
          interaction.client,
          interaction.guildId,
          `✏️ <@${interaction.user.id}> corrigiu os aspects entregues de **${link.username}**: ` +
            `${fmt(res.antes)} → **${fmt(res.agora)}** (saldo ${fmt(saldo)}).`,
        );
        await ensureTomePanel(interaction.client, interaction.guildId).catch(() => null);

        return interaction.editReply(
          `✏️ **${link.username}** — entregues: ${fmt(res.antes)} → **${fmt(res.agora)}**\n` +
            `-# Gerou ${fmt(depois?.earned ?? 0)} em ${depois?.raids ?? 0} raids · saldo agora **${fmt(saldo)}**.${nota}`,
        );
      }

      const a = all.find((x) => x.uuid === link.uuid);
      if (!a || (a.earned === 0 && a.delivered === 0)) {
        return interaction.editReply(`**${link.username}** ainda não gerou aspects (a contagem começa do zero).`);
      }
      const gate = a.eligible ? '' : `\n-# ⏳ ${a.days ?? '?'} dia(s) na guilda — só recebe a partir de ${min} dias.`;
      const devendo =
        a.pending < 0
          ? `\n-# ⚠️ Saldo negativo: recebeu ${fmt(-a.pending)} a mais do que gerou.`
          : '';
      return interaction.editReply(
        `✨ **${a.username}** — **${fmt(a.pending)}** a entregar\n> Já recebeu **${fmt(a.delivered)}** aspect(s) · ${rate}/raid.${gate}${devendo}`,
      );
    }

    // Só quem tem algo relevante (gerado ou já recebido).
    const relevant = all.filter((a) => a.earned > 0 || a.delivered > 0);
    if (!relevant.length) return interaction.editReply('Ninguém gerou aspects desde o início da contagem.');

    // Ordena pelo pendente (o que importa entregar), depois pelo gerado.
    const rows = [...relevant].sort((x, y) => y.pending - x.pending || y.earned - x.earned);
    const totalEarned = relevant.reduce((s, r) => s + r.earned, 0);
    const totalPending = relevant.reduce((s, r) => s + r.pending, 0);

    const lines = rows
      .slice(0, TOP)
      .map(
        (r, i) =>
          `\`${String(i + 1).padStart(2, ' ')}.\` ${r.eligible ? '' : '⏳ '}**${r.username}** — ${fmt(r.pending)} a entregar · já recebeu ${fmt(r.delivered)}`,
      );

    return interaction.editReply({
      embeds: [
        {
          title: '✨ Aspects — guild raids',
          color: 0x9b59b6,
          description: lines.join('\n'),
          fields: [
            {
              name: 'Totais da guilda',
              value: `A entregar: **${fmt(totalPending)}** · Gerado no total: **${fmt(totalEarned)}** (${relevant.length} membros)`,
            },
          ],
          footer: {
            text:
              (rows.length > TOP ? `Mostrando ${TOP} de ${rows.length} · ` : '') +
              `${rate}/raid · conta do zero · ⏳ = ainda sem ${min} dias na guilda`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  },
};
