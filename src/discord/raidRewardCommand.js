import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import {
  RAID_REWARD_KINDS,
  EMERALD_LOT,
  listRewards,
  rewardStatus,
  pendingRewards,
  deliverRewards,
  adjustRewardsDelivered,
  setRewardsDelivered,
  ensureRaidRewardPanel,
} from '../services/raidRewards.js';
import { recordDelivery } from '../services/rewardLog.js';
import { minGuildDays } from '../services/eligibility.js';
import { audit } from '../services/audit.js';
import { autoDismiss, DISMISS } from '../util/ephemeral.js';
import { isRewardManager } from './commands/tome.js';
import { LEVEL, hasLevel, deniedMessage } from '../services/permissions.js';

// `/aspects` e `/esmeraldas` são o MESMO comando para duas recompensas de guild
// raid: a conta, a correção e a entrega só mudam de unidade (1 aspect, ou 1
// lote de 1.024 Es). Um arquivo por comando divergiria na primeira correção
// feita num e esquecida no outro.

const TOP = 25; // linhas da lista; os totais sempre somam todo mundo

// O modal do Discord aceita no máximo 5 campos de texto. Como a staff informa
// quanto entregou a CADA um, o lote de entrega para em 5 — não é escolha nossa,
// é o teto da plataforma.
const MODAL_FIELD_LIMIT = 5;

const fmt = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Qualquer cargo da Staff (ver services/permissions.js). */
async function isStaff(interaction) {
  return hasLevel(interaction.member, LEVEL.STAFF);
}

/**
 * Como está o saldo da pessoa DEPOIS da entrega. São três estados de verdade
 * diferentes, e confundi-los é o que faz a staff entregar duas vezes:
 *
 *  - ainda tem unidade inteira a receber;
 *  - só sobrou fração, que não dá para entregar e fica acumulando;
 *  - ficou devendo, porque recebeu a mais.
 */
function saldoLabel(k, status) {
  if (!status) return 'saldo desconhecido';
  if (status.pending < 0) return `⚠️ recebeu ${k.units(-status.pending)} a mais — as próximas raids quitam`;
  if (status.deliverable >= 1) return `ainda faltam **${k.units(status.deliverable)}**`;
  if (status.remainder) return `sobrou ${k.remainder(status.remainder)} acumulando`;
  return 'nada pendente';
}

/** Responde e marca a efêmera para sumir: o extrato fica no log do painel. */
async function replyAndDismiss(interaction, payload, seconds = DISMISS.delivery) {
  const res = await interaction.editReply(payload);
  autoDismiss(interaction, seconds);
  return res;
}

/**
 * @param {'aspect'|'emerald'} kind
 * @param {string} name         nome do slash command
 * @param {string} description  descrição do slash command
 */
export function raidRewardCommand(kind, name, description) {
  const k = RAID_REWARD_KINDS[kind];
  const unidade = kind === 'emerald' ? `entregas de ${fmt(EMERALD_LOT)} Es` : 'aspects';
  const prefixo = `raid:${kind}:`;

  // ---- Entrega: botão → select → modal ----

  /**
   * Passo 1: escolher quem recebeu, entre os que têm unidade inteira a receber.
   * O teto de 5 é o do modal (um campo por pessoa).
   */
  async function promptDelivery(interaction) {
    if (!(await isRewardManager(interaction))) {
      return interaction.reply({ content: `Apenas a **Staff** pode entregar ${k.title.toLowerCase()}.`, ephemeral: true });
    }
    const pending = await pendingRewards(interaction.guildId, kind);
    if (!pending.length) {
      return interaction.reply({
        content: `Ninguém tem ${kind === 'emerald' ? `um lote inteiro (${fmt(EMERALD_LOT)} Es)` : 'aspect inteiro'} a receber.\n-# Quem tem só fração acumulada aparece no \`/${name}\`, mas não dá para entregar.`,
        ephemeral: true,
      });
    }

    const opcoes = pending.slice(0, MODAL_FIELD_LIMIT);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`${prefixo}pick`)
      .setPlaceholder(`Quem recebeu ${k.title.toLowerCase()}? (até ${MODAL_FIELD_LIMIT})`)
      .setMinValues(1)
      .setMaxValues(opcoes.length)
      .addOptions(
        opcoes.map((a) => ({
          label: a.username,
          value: a.uuid,
          description: `${k.units(a.deliverable)} a entregar`.slice(0, 100),
        })),
      );
    const sobra = pending.length - opcoes.length;
    return interaction.reply({
      content:
        `Selecione quem recebeu — até **${MODAL_FIELD_LIMIT}** por vez. Em seguida você informa quanto entregou a cada um, em ${unidade}.` +
        (sobra ? `\n-# Mais ${sobra} na fila; entregue em rodadas.` : ''),
      components: [new ActionRowBuilder().addComponents(menu)],
      ephemeral: true,
    });
  }

  /**
   * Passo 2: um campo por pessoa, já preenchido com o que ela tem a receber. A
   * staff edita quem precisar — inclusive para MAIS —, e vazio ou zero pula.
   *
   * O customId do modal é FIXO; o uuid vai no campo de cada pessoa (`amt:<uuid>`).
   * Serializar os uuids no customId estoura o teto de 100 caracteres a partir do
   * terceiro destinatário.
   */
  async function promptAmount(interaction) {
    if (!(await isRewardManager(interaction))) {
      return interaction.update({ content: 'Sem permissão.', components: [] });
    }
    const pending = await pendingRewards(interaction.guildId, kind);
    const alvos = interaction.values
      .slice(0, MODAL_FIELD_LIMIT)
      .map((uuid) => pending.find((a) => a.uuid === uuid))
      .filter(Boolean);
    if (!alvos.length) {
      return interaction.update({ content: 'Ninguém da seleção tem unidade inteira a receber agora.', components: [] });
    }

    const modal = new ModalBuilder()
      .setCustomId(`${prefixo}amount`)
      .setTitle(`Entregar ${k.title.toLowerCase()}`)
      .addComponents(
        ...alvos.map((a) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(`amt:${a.uuid}`)
              // O label do Discord vai a 45 caracteres; nick vai a 20, então cabe.
              .setLabel(`${a.username} (a receber: ${a.deliverable})`.slice(0, 45))
              .setValue(String(a.deliverable))
              .setPlaceholder(
                kind === 'emerald'
                  ? `Nº de entregas (1 = ${fmt(EMERALD_LOT)} Es). 0 ou vazio = pular`
                  : 'Unidades inteiras. 0 ou vazio = pular',
              )
              .setStyle(TextInputStyle.Short)
              .setRequired(false),
          ),
        ),
      );
    return interaction.showModal(modal);
  }

  /**
   * Passo 3: aplica o que a staff digitou. Aceita MAIS do que o saldo de
   * propósito (vira saldo negativo); não aceita fração — a entrega é inteira.
   */
  async function applyDelivery(interaction) {
    if (!(await isRewardManager(interaction))) {
      return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });

    const uuids = [...interaction.fields.fields.keys()]
      .filter((f) => f.startsWith('amt:'))
      .map((f) => f.slice('amt:'.length));

    const entregues = [];
    const invalidos = [];
    let total = 0;

    for (const uuid of uuids) {
      const bruto = (interaction.fields.getTextInputValue(`amt:${uuid}`) ?? '').trim();
      // Vazio ou zero = a staff decidiu não entregar a essa pessoa agora.
      if (!bruto || bruto === '0') continue;

      const antes = await rewardStatus(interaction.guildId, kind, uuid);
      const nome = antes?.username ?? uuid;
      const valor = Number(bruto.replace(',', '.'));
      if (!Number.isInteger(valor) || valor <= 0) {
        invalidos.push(`**${nome}**: \`${bruto}\``);
        continue;
      }

      await deliverRewards(kind, uuid, valor);
      const link = await collections.members().findOne({ uuid }, { projection: { discordId: 1 } });
      await recordDelivery({
        kind,
        uuid,
        username: nome,
        discordId: link?.discordId ?? null,
        amount: valor,
        byDiscordId: interaction.user.id,
      });
      total += valor;
      // Relê DEPOIS da entrega: o resumo tem de refletir o estado novo.
      entregues.push({ valor, status: await rewardStatus(interaction.guildId, kind, uuid) });
    }

    await ensureRaidRewardPanel(interaction.client, interaction.guildId, kind);

    const aviso = invalidos.length ? `\n⚠️ Ignorado (não é número inteiro): ${invalidos.join(', ')}.` : '';
    if (!entregues.length) return replyAndDismiss(interaction, `Nada entregue.${aviso}`, DISMISS.member);

    const linhas = entregues.map(
      (e) => `> **${e.status?.username ?? '?'}** — ${k.units(e.valor)} · ${saldoLabel(k, e.status)}`,
    );
    return replyAndDismiss(
      interaction,
      `${k.emoji} **${k.units(total)}** entregue(s) a **${entregues.length}** pessoa(s).\n${linhas.join('\n')}${aviso}`,
      aviso ? DISMISS.member : DISMISS.delivery,
    );
  }

  // ---- Consulta e correção ----

  async function correct(interaction, link, ajustar, corrigir) {
    // `ajustar` já vem com o sinal que a pessoa quis: +3 soma ao entregue, -2
    // tira. É o mesmo verbo para os dois erros (esqueci de registrar /
    // registrei demais), sem inversão escondida no meio do caminho.
    const res =
      ajustar !== null
        ? await adjustRewardsDelivered(kind, link.uuid, ajustar)
        : await setRewardsDelivered(kind, link.uuid, corrigir);
    if (!res) {
      return interaction.editReply(
        ajustar === 0
          ? 'Ajustar zero não faz nada. Use um número com sinal, ex.: `-2` para tirar 2 ou `3` para somar 3.'
          : `**${link.username}** não tem registro em guildStats.`,
      );
    }

    // Relê depois da escrita: o saldo já reflete a correção, inclusive negativo.
    const depois = await rewardStatus(interaction.guildId, kind, link.uuid);
    const saldo = depois?.pending ?? 0;
    const nota =
      saldo < 0
        ? `\n-# ⚠️ Saldo **negativo**: ${k.units(-saldo)} a mais do que gerou. As próximas raids quitam isso antes de render de novo.`
        : '';

    await audit(
      interaction.client,
      interaction.guildId,
      `✏️ <@${interaction.user.id}> corrigiu ${k.title.toLowerCase()} entregues a **${link.username}**: ` +
        `${k.units(res.antes)} → **${k.units(res.agora)}** (saldo ${fmt(saldo)}).`,
    );
    await ensureRaidRewardPanel(interaction.client, interaction.guildId, kind).catch(() => null);

    return interaction.editReply(
      `✏️ **${link.username}** — entregues: ${k.units(res.antes)} → **${k.units(res.agora)}**\n` +
        `-# Gerou ${k.units(depois?.earned ?? 0)} no total · saldo agora **${fmt(saldo)}**.${nota}`,
    );
  }

  async function showOne(interaction, link) {
    const min = await minGuildDays(interaction.guildId);
    const a = await rewardStatus(interaction.guildId, kind, link.uuid);
    if (!a || (a.earned === 0 && a.delivered === 0)) {
      return interaction.editReply(`**${link.username}** ainda não gerou ${k.title.toLowerCase()} em guild raids.`);
    }
    const gate = a.eligible ? '' : `\n-# ⏳ ${a.days ?? '?'} dia(s) na guilda — só recebe a partir de ${min} dias.`;
    const devendo = a.pending < 0 ? `\n-# ⚠️ Saldo negativo: recebeu ${k.units(-a.pending)} a mais do que gerou.` : '';
    // A fração é informação legítima aqui (é o saldo real), mas o número que
    // importa para AGIR é quantas unidades inteiras dá para passar.
    const sobra = a.remainder ? ` (+${k.remainder(a.remainder)} acumulando)` : '';
    return interaction.editReply(
      `${k.emoji} **${a.username}** — **${k.units(a.deliverable)}** a entregar${sobra}\n` +
        `> Já recebeu **${k.units(a.delivered)}** · gerou **${k.units(a.earned)}** no total.${gate}${devendo}`,
    );
  }

  async function showAll(interaction) {
    const min = await minGuildDays(interaction.guildId);
    const relevant = (await listRewards(interaction.guildId, kind)).filter((a) => a.earned > 0 || a.delivered > 0);
    if (!relevant.length) return interaction.editReply(`Ninguém gerou ${k.title.toLowerCase()} em guild raids ainda.`);

    // Ordena pelo que dá para entregar (o que importa agir), depois pelo saldo.
    const rows = [...relevant].sort((x, y) => y.deliverable - x.deliverable || y.pending - x.pending);
    const totalEarned = relevant.reduce((s, r) => s + r.earned, 0);
    const totalDeliverable = relevant.reduce((s, r) => s + r.deliverable, 0);

    const lines = rows.slice(0, TOP).map((r, i) => {
      const sobra = r.remainder ? ` (+${k.remainder(r.remainder)})` : '';
      return `\`${String(i + 1).padStart(2, ' ')}.\` ${r.eligible ? '' : '⏳ '}**${r.username}** — ${k.units(r.deliverable)} a entregar${sobra} · já recebeu ${k.units(r.delivered)}`;
    });

    return interaction.editReply({
      embeds: [
        {
          title: `${k.emoji} ${k.title} — guild raids`,
          color: k.color,
          description: lines.join('\n').slice(0, 4000),
          fields: [
            {
              name: 'Totais da guilda',
              value: `A entregar: **${k.units(totalDeliverable)}** · Gerado no total: **${k.units(totalEarned)}** (${relevant.length} membros)`,
            },
          ],
          footer: {
            text:
              (rows.length > TOP ? `Mostrando ${TOP} de ${rows.length} · ` : '') +
              `dividido igualmente pelo grupo de cada raid · ⏳ = ainda sem ${min} dias na guilda`,
          },
          timestamp: new Date().toISOString(),
        },
      ],
    });
  }

  return {
    data: new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .setDefaultMemberPermissions(0)
      .addUserOption((o) => o.setName('user').setDescription(`Ver o saldo de um jogador específico`).setRequired(false))
      // Correção de entrega digitada errada. Vivem como OPÇÕES, e não como
      // subcomando, para o comando puro continuar listando todo mundo.
      //
      // Duas formas porque as duas situações são diferentes: `ajustar` mexe no
      // que já foi entregue sem precisar saber o acumulado, e `entregues`
      // reescreve o total quando se sabe o número certo. Inteiros nos dois: o
      // que se corrige é quanto SAIU do baú, sempre em unidades inteiras.
      .addIntegerOption((o) =>
        o
          .setName('ajustar')
          .setDescription(`(Corrige) ${kind === 'emerald' ? 'Entregas' : 'Unidades'} a MAIS (+3) ou a MENOS (-2) no já entregue. Exige "user".`)
          .setRequired(false),
      )
      .addIntegerOption((o) =>
        o
          .setName('entregues')
          .setDescription(`(Corrige) Novo TOTAL já entregue${kind === 'emerald' ? ', em entregas de 1.024 Es' : ''}. Exige "user".`)
          .setMinValue(0)
          .setRequired(false),
      )
      .toJSON(),

    owns(interaction) {
      return typeof interaction.customId === 'string' && interaction.customId.startsWith(prefixo);
    },

    async handleComponent(interaction) {
      const action = interaction.customId.slice(prefixo.length);
      if (action === 'deliver') return promptDelivery(interaction);
      if (action === 'pick') return promptAmount(interaction);
      if (action === 'amount') return applyDelivery(interaction);
    },

    async execute(interaction) {
      if (!(await isStaff(interaction))) {
        return interaction.reply({ content: `Apenas a staff pode consultar ${k.title.toLowerCase()}.`, ephemeral: true });
      }
      await interaction.deferReply({ ephemeral: true });

      const user = interaction.options.getUser('user');
      const corrigir = interaction.options.getInteger('entregues');
      const ajustar = interaction.options.getInteger('ajustar');
      if (corrigir !== null && ajustar !== null) {
        return interaction.editReply('Use **uma** das duas: `ajustar` (quanto somar ou tirar) ou `entregues` (o total certo).');
      }
      if ((corrigir !== null || ajustar !== null) && !user) {
        return interaction.editReply(
          'Para corrigir, informe também o **user**:\n' +
            `• \`/${name} user:@fulano ajustar:-18\` — tira 18 do que já foi entregue\n` +
            `• \`/${name} user:@fulano ajustar:3\` — soma 3 que você entregou e não registrou\n` +
            `• \`/${name} user:@fulano entregues:2\` — reescreve o total para 2` +
            (kind === 'emerald' ? `\n-# Sempre em entregas: 1 = ${fmt(EMERALD_LOT)} Es.` : ''),
        );
      }

      if (!user) return showAll(interaction);

      const link = await collections.members().findOne({ discordId: user.id });
      if (!link) return interaction.editReply(`<@${user.id}> não está vinculado a nenhuma conta.`);
      if (corrigir !== null || ajustar !== null) return correct(interaction, link, ajustar, corrigir);
      return showOne(interaction, link);
    },
  };
}
