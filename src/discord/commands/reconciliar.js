import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import {
  computeReconciliation,
  reconciliationPanel,
  applyReconciliation,
} from '../../services/reconciliation.js';
import { sweepMembers } from '../../services/registration.js';
import { getConfig } from '../../config/guildConfig.js';
import { audit } from '../../services/audit.js';

const APPLY_SCOPES = new Set(['member', 'ally', 'neutral', 'banned', 'unregistered', 'all']);

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
    .setDescription('(Staff) Painel para conferir e corrigir os cargos e apelidos de todo o servidor')
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

    // Varredura completa, na ordem em que uma coisa habilita a outra:
    //
    //   1. registra quem não tem vínculo (consultando o apelido na API);
    //   2. confere se o nick de quem JÁ tem vínculo continua sendo o do jogo;
    //   3. aplica cargos e apelidos de todo mundo que estiver fora de sincronia.
    //
    // Os passos 1 e 2 precisam vir antes do 3: é o vínculo que revela a grafia
    // oficial do nick, e sem ele o passo 3 não teria o que comparar.
    if (action === 'register') {
      await interaction.deferUpdate();

      const inicial = await computeReconciliation(interaction.guild);
      if (!inicial) return interaction.editReply({ content: 'Não consegui obter os dados da guilda.', embeds: [], components: [] });

      const summary = await sweepMembers(interaction.guild, {
        actorId: interaction.user.id,
        // Os nomes que o retrato já baixou dos rosters saem de graça: só o
        // neutro, que não está em roster nenhum, custa consulta.
        canonicalByUuid: inicial.canonicalByUuid,
        onProgress: (s) => interaction.editReply(progressPanel(s)),
      });

      const { applied, data } = await applyReconciliation(interaction.guild, 'all');
      audit(
        interaction.client,
        interaction.guildId,
        `🔗 <@${interaction.user.id}> varreu o servidor: **${summary.registered}** novo(s) vínculo(s), ` +
          `**${summary.renamed}** nick(s) atualizado(s) e **${applied}** membro(s) reconciliado(s) de **${summary.scanned}** varridos.`,
      );
      return interaction.editReply(reconciliationPanel(data ?? inicial, sweepNote(summary, applied)));
    }

    // Seleção de indivíduos: aplica cada um com a classificação recomputada.
    if (action === 'select') {
      await interaction.deferUpdate();
      const { applied, data } = await applyReconciliation(interaction.guild, 'all', interaction.values);
      audit(interaction.client, interaction.guildId, `🔧 <@${interaction.user.id}> reconciliou **${applied}** membro(s) (seleção).`);
      return interaction.editReply(reconciliationPanel(data, note(applied)));
    }

    // Botões de grupo.
    if (action === 'apply' && APPLY_SCOPES.has(scope)) {
      await interaction.deferUpdate();
      const { applied, data } = await applyReconciliation(interaction.guild, scope);
      audit(interaction.client, interaction.guildId, `🔧 <@${interaction.user.id}> reconciliou **${applied}** membro(s) (${scope}).`);
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
    ? `✅ **${applied}** membro(s) corrigido(s) — cargos e apelidos. Retrato atualizado abaixo.`
    : 'Nada a aplicar — ninguém elegível na seleção.';
}

/**
 * O painel enquanto a varredura corre. Sem botões de propósito: um segundo
 * clique dispararia uma varredura paralela sobre os mesmos membros.
 */
function progressPanel(s) {
  return {
    embeds: [
      {
        title: '🔗 Varrendo o servidor…',
        color: 0x3498db,
        description:
          `**${s.scanned}** membros vistos · **${s.lookups}** consultas à API\n` +
          `**${s.registered}** vinculado(s) · **${s.revalidated}** vínculo(s) conferido(s) · **${s.renamed}** nick(s) atualizado(s)`,
        footer: { text: 'O painel volta sozinho quando terminar.' },
      },
    ],
    components: [],
  };
}

function sweepNote(s, applied) {
  const partes = [
    `🔗 Varredura: **${s.registered}** novo(s) vínculo(s) de **${s.scanned}** membros, e **${applied}** membro(s) com cargo/apelido corrigido(s).`,
    `Já vinculados: **${s.already}** · Apelido que não é nick: **${s.invalid}** · Nick não encontrado na API: **${s.notFound}**`,
    `-# Consultas à API nesta rodada: ${s.lookups}.`,
  ];
  // Quem trocou de nome no jogo: o vínculo passou a apontar para o nick novo, e
  // o apelido no Discord foi junto.
  if (s.renamed) {
    partes.push(`🪪 Nicks atualizados: **${s.renamed}** de **${s.revalidated}** vínculos conferidos — ${s.renames.join(', ')}${s.renamed > s.renames.length ? ' …' : ''}`);
  }
  if (s.conflicts) partes.push(`⚠️ Conflitos (apelido de conta já vinculada a outro): **${s.conflicts}** — use \`/forcelink\` caso queira sobrescrever.`);
  // Nick que casa com mais de uma conta do WynnCraft. O bot não chuta qual é —
  // vincular a errada daria a conta de alguém a outra pessoa.
  if (s.ambiguous) partes.push(`❓ Apelido que corresponde a mais de uma conta: **${s.ambiguous}** — resolva com \`/forcelink\` usando a grafia exata do nick.`);
  if (s.failed) partes.push(`⚠️ Falhas inesperadas: **${s.failed}** — a varredura seguiu; veja o log do bot.`);
  if (s.registered) partes.push(`Classificação: 🟢 ${s.byKind.member} membro(s) · 🤝 ${s.byKind.ally} aliado(s) · ⚪ ${s.byKind.neutral} comunidade · 🚫 ${s.byKind.banned} banido(s).`);
  if (s.rateLimited) {
    partes.push(`⏳ A API do WynnCraft começou a limitar e eu parei por aí. **${s.remaining}** ficaram para depois — espere um minuto e clique de novo.`);
  } else if (s.remaining) {
    partes.push(`⏳ **${s.remaining}** não couberam no tempo desta rodada (10 min, limite do token da interação). Clique de novo para continuar de onde parou.`);
  }
  return partes.join('\n');
}
