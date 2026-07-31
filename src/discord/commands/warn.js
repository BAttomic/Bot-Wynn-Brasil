import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { collections } from '../../db/mongo.js';
import { wynn } from '../../wynn/api.js';
import { getConfig } from '../../config/guildConfig.js';
import { applyClassificationRoles } from '../../services/registration.js';
import {
  recordWarn,
  escalate,
  removeWarn,
  clearWarns,
  findWarn,
  warnHistory,
  countActiveWarns,
} from '../../services/warns.js';
import { audit } from '../../services/audit.js';

const ts = (d) => (d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:d>` : '—');

/**
 * Resolve o alvo. Diferente do /ban, aqui o uuid é OPCIONAL: dá para advertir
 * quem nunca se registrou. Sem uuid a advertência vale igual, só não vira ban
 * automático (o ban é indexado por uuid) — e o comando avisa a staff disso.
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

/** DM ao advertido. Falha calada aqui, mas o comando reporta se não passou. */
async function notify(client, target, { reason, active, threshold, banned }) {
  if (!target.discordId) return false;
  const user = await client.users.fetch(target.discordId).catch(() => null);
  if (!user) return false;

  const restam = threshold ? threshold - active : 0;
  const aviso = banned
    ? '\n\n🚫 Com esta advertência você atingiu o limite e **foi banido**. Se discordar, procure a staff.'
    : threshold && restam > 0
      ? `\n\nVocê tem **${active}** advertência(s) ativa(s). Mais **${restam}** e o banimento é automático.`
      : `\n\nVocê tem **${active}** advertência(s) ativa(s).`;

  const sent = await user
    .send({
      embeds: [
        {
          title: '⚠️ Você recebeu uma advertência',
          description: `**Motivo:** ${reason}${aviso}`,
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
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Adverte um membro')
        .addStringOption((o) => o.setName('motivo').setDescription('Motivo da advertência').setRequired(true))
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

    if (sub === 'remove') {
      const id = interaction.options.getString('id', true).trim();
      const motivo = interaction.options.getString('motivo');
      const warn = await findWarn(id);
      if (!warn) return interaction.editReply(`Nenhuma advertência com o id \`${id}\`.`);
      if (warn.removed) return interaction.editReply(`A advertência \`${id}\` já tinha sido perdoada.`);

      await removeWarn(id, interaction.user.id, motivo);
      const active = await countActiveWarns(gid, { uuid: warn.uuid, discordId: warn.discordId });
      audit(
        interaction.client,
        gid,
        `♻️ <@${interaction.user.id}> perdoou a advertência \`${id}\` de **${warn.username ?? warn.discordId}**${motivo ? ` — *${motivo}*` : ''}. Restam ${active} ativa(s).`,
      );
      return interaction.editReply(
        `Advertência \`${id}\` perdoada. **${warn.username ?? `<@${warn.discordId}>`}** fica com **${active}** ativa(s).\n-# O registro continua no histórico, marcado como perdoado. O ban por acúmulo, se já tiver ocorrido, **não** é desfeito — use \`/ban remove\`.`,
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

      const { params } = await getConfig(gid);
      const ativas = hist.filter((w) => w.active).length;
      const linhas = hist.map((w) => {
        const marca = w.removed ? '~~perdoada~~' : w.expired ? '*expirada*' : '**ativa**';
        return `\`${w.warnId}\` ${marca} · ${ts(w.at)} · por <@${w.by}>\n  ${w.reason}`;
      });

      return interaction.editReply({
        embeds: [
          {
            title: `⚠️ Advertências — ${nameOf(target)}`,
            description: linhas.join('\n').slice(0, 4000),
            color: ativas ? 0xf39c12 : 0x2ecc71,
            footer: {
              text: `${ativas} ativa(s) de ${hist.length} · ban automático em ${params.warnsToBan} · expiram em ${params.warnExpiryDays} dias`,
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
    const { warn, active, threshold } = await recordWarn(gid, {
      ...target,
      reason: motivo,
      by: interaction.user.id,
    });

    const esc = await escalate(gid, { ...target, active, threshold });

    // O cargo entra já, se a pessoa estiver no servidor — o roleSync levaria até
    // 10 min, e um ban que demora a aparecer é um ban que a pessoa contorna.
    if (esc.banned && target.discordId) {
      const member = await interaction.guild.members.fetch(target.discordId).catch(() => null);
      if (member) await applyClassificationRoles(member, await getConfig(gid), 'banned');
    }

    const dm = await notify(interaction.client, target, {
      reason: motivo,
      active,
      threshold,
      banned: esc.banned,
    });

    audit(
      interaction.client,
      gid,
      `⚠️ <@${interaction.user.id}> advertiu **${nameOf(target)}** (\`${warn.warnId}\`) — *${motivo}*. Ativas: **${active}**${threshold ? `/${threshold}` : ''}.${esc.banned ? ' 🚫 **Banido por acúmulo.**' : ''}`,
    );

    const notas = [];
    if (esc.banned) notas.push('🚫 **Limite atingido — banido automaticamente.**');
    if (esc.reason === 'noUuid') {
      notas.push(
        '⚠️ Atingiu o limite, mas **não deu para banir**: essa pessoa não tem conta do WynnCraft vinculada, e o banimento é indexado por conta. Rode `/ban add` com o `nick` dela.',
      );
    }
    if (esc.reason === 'exempt') {
      notas.push('ℹ️ Atingiu o limite, mas a pessoa está **isenta** por decisão anterior da staff — não foi banida.');
    }
    if (!dm) {
      notas.push(
        target.discordId
          ? '📪 Não consegui enviar a DM (provavelmente fechada). Avise por outro canal.'
          : '📪 Sem Discord vinculado: a pessoa não foi notificada.',
      );
    }

    return interaction.editReply(
      `Advertência registrada para **${nameOf(target)}**.\nId: \`${warn.warnId}\`\nMotivo: *${motivo}*\nAtivas: **${active}**${threshold ? ` de ${threshold}` : ''}${notas.length ? `\n\n${notas.join('\n')}` : ''}`,
    );
  },
};
