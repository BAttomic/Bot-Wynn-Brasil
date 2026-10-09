import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';
import {
  GRAVIDADES,
  gravidadeDe,
  expiresAt,
  recordWarn,
  editWarn,
  removeWarn,
  clearWarns,
  findWarn,
  warnHistory,
  activeSummary,
} from '../../services/warns.js';
import { audit } from '../../services/audit.js';

const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>` : '—');

/**
 * Resolve o alvo. Diferente do /ban, aqui o uuid é OPCIONAL: dá para advertir
 * quem nunca se registrou.
 */
async function resolveTarget({ user, nick }) {
  const out = { uuid: null, username: null, discordId: user?.id ?? null };

  if (user) {
    const linked = await collections.members().findOne({ discordId: user.id });
    if (linked) {
      out.uuid = linked.uuid;
      out.username = linked.username;
    }
  }
  if (!out.uuid && nick) {
    const player = await wynn.player(nick).catch(() => null);
    if (player?.uuid) {
      out.uuid = player.uuid;
      out.username = player.username;
    } else {
      return null; // nick informado e inválido: melhor errar do que advertir outra pessoa
    }
  }
  if (!out.uuid && !out.discordId) return null;
  return out;
}

const nameOf = (t) => t.username ?? (t.discordId ? `<@${t.discordId}>` : t.uuid);

/** "Média (2 pontos, 2 meses)". */
function gravidadeTexto(w) {
  const g = gravidadeDe(w);
  const s = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  return `${g.label} (${s(g.pontos, 'ponto', 'pontos')}, ${s(g.meses, 'mês', 'meses')})`;
}

/** "3 ponto(s) em 2 advertência(s) ativa(s)". */
const resumo = ({ active, pontos }) => `**${pontos}** ponto(s) em **${active}** advertência(s) ativa(s)`;

/**
 * DM ao advertido. Falha calada aqui, mas o comando reporta se não passou.
 * `titulo`/`antes`: na edição, o aviso diz que a advertência mudou e o que era.
 */
async function notify(client, target, { warn, estado, titulo = '⚠️ Você recebeu uma advertência', antes = '' }) {
  if (!target.discordId) return false;
  const user = await client.users.fetch(target.discordId).catch(() => null);
  if (!user) return false;

  const sent = await user
    .send({
      embeds: [
        {
          title: titulo,
          description:
            `**Motivo:** ${warn.reason}\n**Gravidade:** ${gravidadeTexto(warn)}\n` +
            `Conta até ${ts(expiresAt(warn))}.${antes}\n\nVocê tem ${resumo(estado)}.`,
          color: 0xf39c12,
          timestamp: new Date().toISOString(),
        },
      ],
    })
    .catch(() => null);
  return !!sent;
}

export default {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('(Staff) Advertências')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Adverte um membro')
        .addStringOption((o) => o.setName('motivo').setDescription('Motivo da advertência').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('gravidade')
            .setDescription('Quanto pesa e por quanto tempo conta')
            .setRequired(true)
            .addChoices(
              ...Object.entries(GRAVIDADES).map(([value, g]) => ({ name: gravidadeTexto({ severity: value }), value })),
            ),
        )
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('list')
        .setDescription('Histórico de advertências de alguém')
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('edit')
        .setDescription('Corrige a gravidade e/ou o motivo de uma advertência')
        .addStringOption((o) => o.setName('id').setDescription('Id mostrado em /warn list').setRequired(true))
        .addStringOption((o) =>
          o
            .setName('gravidade')
            .setDescription('Nova gravidade; o prazo continua contando da data original')
            .addChoices(
              ...Object.entries(GRAVIDADES).map(([value]) => ({ name: gravidadeTexto({ severity: value }), value })),
            ),
        )
        .addStringOption((o) => o.setName('motivo').setDescription('Novo motivo')),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Perdoa uma advertência pelo id')
        .addStringOption((o) => o.setName('id').setDescription('Id mostrado em /warn list').setRequired(true))
        .addStringOption((o) => o.setName('motivo').setDescription('Por que está perdoando').setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName('clear')
        .setDescription('Perdoa TODAS as advertências ativas de alguém')
        .addUserOption((o) => o.setName('user').setDescription('Usuário do Discord').setRequired(false))
        .addStringOption((o) => o.setName('nick').setDescription('Nick no WynnCraft').setRequired(false))
        .addStringOption((o) => o.setName('motivo').setDescription('Por que está perdoando').setRequired(false)),
    )
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guildId;

    if (sub === 'edit') {
      const id = interaction.options.getString('id', true).trim();
      const severity = interaction.options.getString('gravidade');
      const reason = interaction.options.getString('motivo')?.trim() || null;
      if (!severity && !reason) return interaction.editReply('Informe a nova `gravidade`, o novo `motivo`, ou os dois.');
      const antes = await findWarn(id);
      if (!antes) return interaction.editReply(`Nenhuma advertência com o id \`${id}\`.`);
      if (antes.removed) return interaction.editReply(`A advertência \`${id}\` foi perdoada: não dá para editar.`);

      const warn = await editWarn(id, { severity, reason }, interaction.user.id);
      if (!warn) return interaction.editReply(`Nada mudou na advertência \`${id}\`: ela já está assim.`);

      const mudou = [];
      if (gravidadeDe(warn) !== gravidadeDe(antes)) mudou.push(`gravidade ${gravidadeTexto(antes)} → ${gravidadeTexto(warn)}`);
      if (warn.reason !== antes.reason) mudou.push(`motivo *${antes.reason}* → *${warn.reason}*`);
      const alvo = { uuid: warn.uuid, discordId: warn.discordId, username: warn.username };
      const estado = await activeSummary(gid, alvo);
      const vencida = expiresAt(warn) <= new Date() ? '\n-# Com a gravidade nova, o prazo já passou: ela não conta mais.' : '';
      const dm = await notify(interaction.client, alvo, {
        warn,
        estado,
        titulo: '✏️ Uma advertência sua foi alterada',
        antes: `\n-# Antes: ${gravidadeTexto(antes)} — ${antes.reason}`,
      });

      audit(
        interaction.client,
        gid,
        `✏️ <@${interaction.user.id}> editou a advertência \`${id}\` de **${nameOf(alvo)}**: ${mudou.join('; ')}. Ativos: **${estado.pontos}** ponto(s) em ${estado.active} advertência(s).`,
      );
      return interaction.editReply(
        `Advertência \`${id}\` editada: ${mudou.join('; ')}.\nConta até ${ts(expiresAt(warn))}.${vencida}\n` +
          `**${nameOf(alvo)}** fica com ${resumo(estado)}.` +
          (dm ? '' : `\n\n📪 ${alvo.discordId ? 'Não consegui avisar por DM.' : 'Sem Discord vinculado: a pessoa não foi avisada.'}`),
      );
    }

    if (sub === 'remove') {
      const id = interaction.options.getString('id', true).trim();
      const motivo = interaction.options.getString('motivo');
      const warn = await findWarn(id);
      if (!warn) return interaction.editReply(`Nenhuma advertência com o id \`${id}\`.`);
      if (warn.removed) return interaction.editReply(`A advertência \`${id}\` já tinha sido perdoada.`);

      await removeWarn(id, interaction.user.id, motivo);
      const estado = await activeSummary(gid, { uuid: warn.uuid, discordId: warn.discordId });
      audit(
        interaction.client,
        gid,
        `♻️ <@${interaction.user.id}> perdoou a advertência \`${id}\` de **${warn.username ?? warn.discordId}**${motivo ? ` — *${motivo}*` : ''}. Restam ${estado.pontos} ponto(s) em ${estado.active} ativa(s).`,
      );
      return interaction.editReply(
        `Advertência \`${id}\` perdoada. **${warn.username ?? `<@${warn.discordId}>`}** fica com ${resumo(estado)}.\n-# O registro continua no histórico, marcado como perdoado. Advertência não bane ninguém: banimento é só pelo \`/ban\`.`,
      );
    }

    const user = interaction.options.getUser('user');
    const nick = interaction.options.getString('nick');
    if (!user && !nick) return interaction.editReply('Informe `user`, `nick`, ou os dois.');

    const target = await resolveTarget({ user, nick });
    if (!target) {
      return interaction.editReply('Não consegui identificar a conta. Confira o `nick` ou informe um `user`.');
    }

    if (sub === 'list') {
      const hist = await warnHistory(gid, target, 25);
      if (!hist.length) return interaction.editReply(`**${nameOf(target)}** não tem advertência nenhuma.`);

      const ativas = hist.filter((w) => w.active);
      const pontos = ativas.reduce((s, w) => s + gravidadeDe(w).pontos, 0);
      const linhas = hist.map((w) => {
        const marca = w.removed ? '~~perdoada~~' : w.expired ? '*expirada*' : `**ativa** até ${ts(w.expiresAt)}`;
        const editada = w.edits?.length ? ` · ✏️ editada por <@${w.edits.at(-1).by}>` : '';
        return `\`${w.warnId}\` ${marca} · ${gravidadeDe(w).label} (${gravidadeDe(w).pontos}) · ${ts(w.at)} · por <@${w.by}>${editada}\n  ${w.reason}`;
      });

      return interaction.editReply({
        embeds: [
          {
            title: `⚠️ Advertências — ${nameOf(target)}`,
            description: linhas.join('\n').slice(0, 4000),
            color: ativas.length ? 0xf39c12 : 0x2ecc71,
            footer: {
              text: `${pontos} ponto(s) em ${ativas.length} ativa(s) de ${hist.length} · baixa 1 mês, média 2, grave 3`,
            },
          },
        ],
      });
    }

    if (sub === 'clear') {
      const motivo = interaction.options.getString('motivo');
      const n = await clearWarns(gid, target, interaction.user.id, motivo);
      if (!n) return interaction.editReply(`**${nameOf(target)}** não tem advertência ativa.`);
      audit(
        interaction.client,
        gid,
        `♻️ <@${interaction.user.id}> perdoou **${n}** advertência(s) de **${nameOf(target)}**${motivo ? ` — *${motivo}*` : ''}.`,
      );
      return interaction.editReply(`**${n}** advertência(s) perdoada(s) de **${nameOf(target)}**.`);
    }

    // add
    const motivo = interaction.options.getString('motivo', true);
    const { warn, ...estado } = await recordWarn(gid, {
      ...target,
      reason: motivo,
      severity: interaction.options.getString('gravidade', true),
      by: interaction.user.id,
    });

    const dm = await notify(interaction.client, target, { warn, estado });

    audit(
      interaction.client,
      gid,
      `⚠️ <@${interaction.user.id}> advertiu **${nameOf(target)}** (\`${warn.warnId}\`), gravidade ${gravidadeTexto(warn)} — *${motivo}*. Ativos: **${estado.pontos}** ponto(s) em ${estado.active} advertência(s).`,
    );

    const notas = [];
    if (!dm) {
      notas.push(
        target.discordId
          ? '📪 Não consegui enviar a DM (provavelmente fechada). Avise por outro canal.'
          : '📪 Sem Discord vinculado: a pessoa não foi notificada.',
      );
    }

    return interaction.editReply(
      `Advertência registrada para **${nameOf(target)}**.\nId: \`${warn.warnId}\`\nMotivo: *${motivo}*\n` +
        `Gravidade: ${gravidadeTexto(warn)} · conta até ${ts(expiresAt(warn))}\n` +
        `Agora: ${resumo(estado)}${notas.length ? `\n\n${notas.join('\n')}` : ''}`,
    );
  },
};
