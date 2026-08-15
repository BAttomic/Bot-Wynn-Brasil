import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { collections } from '../../db/mongo.js';
import {
  queueView,
  deliverTome,
  tomeCredits,
  ensureTomePanel,
  ensureDeliveryLogPanel,
  recordDelivery,
} from '../../services/tomes.js';
import { pendingAspects, deliverAspects, aspectStatus } from '../../services/aspects.js';
import { maxClassLevel, tomeMinLevel } from '../../services/eligibility.js';
import { autoDismiss, DISMISS } from '../../util/ephemeral.js';

const fmtAsp = (n) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/**
 * Republica os dois painéis do canal: a fila ao vivo e o histórico.
 *
 * Substituiu o anúncio por entrega. Antes, cada Tome ou aspect virava uma
 * mensagem nova no canal — para o premiado (com ping) e à vista de todos —, e
 * 24h depois a limpeza apagava tudo, sem deixar registro de quem recebeu o quê.
 * Agora a entrega vira uma linha no painel de histórico, que é EDITADO: não
 * pinga ninguém, não empurra o canal para baixo, e o extrato fica.
 */
async function refreshPanels(interaction) {
  await ensureTomePanel(interaction.client, interaction.guildId);
  await ensureDeliveryLogPanel(interaction.client, interaction.guildId);
}

/**
 * Responde e marca a efêmera para sumir.
 *
 * Efêmera não polui o canal, mas empilha na tela de quem clicou até ser
 * dispensada uma a uma — e quem entrega recompensa faz isso em série. O extrato
 * do que aconteceu fica no painel de histórico, então nada aqui precisa durar.
 */
async function replyAndDismiss(interaction, payload, seconds = DISMISS.delivery) {
  const res = await interaction.editReply(payload);
  autoDismiss(interaction, seconds);
  return res;
}

/**
 * O acumulado da pessoa, em citação (`>`), para a confirmação de quem entregou.
 *
 * A fila vale por UM: receber tira da fila mesmo quem ainda tem crédito, então a
 * linha precisa dizer o que fazer para pegar o próximo, senão a pessoa fica
 * esperando uma vez que não vem.
 */
function tomeSummary({ username, delivered, credits }) {
  const total = `**${username}** já recebeu **${delivered}** Tome(s)`;
  return credits > 0
    ? `> ${total} · ainda tem direito a **${credits}** — a fila vale por 1, então precisa entrar nela de novo.`
    : `> ${total} · sem crédito agora — cada missão semanal da guilda dá direito a mais 1.`;
}

/** O mesmo, para aspects: acumulado entregue e o que ainda sobra. */
function aspectSummary(status) {
  if (!status) return null;
  const total = `**${status.username}** já recebeu **${fmtAsp(status.delivered)}** aspect(s)`;
  return status.pending > 0
    ? `> ${total} · ainda faltam **${fmtAsp(status.pending)}** a entregar.`
    : `> ${total} · nada pendente no momento.`;
}

// Ações abertas a qualquer membro. `queue` saiu daqui junto com o botão "Ver
// fila": a fila já está no painel, e o botão só produzia uma cópia efêmera dela.
// O `/tome queue` continua existindo — quem digita o comando está pedindo, não
// sendo bombardeado.
/** @type {readonly string[]} */
const BUTTON_ACTIONS = Object.freeze(['join', 'leave']);

/**
 * Ranks DA GUILDA que podem entregar um Tome. "Chief ou superior".
 * @type {readonly string[]}
 */
const MANAGER_GUILD_RANKS = Object.freeze(['chief', 'owner']);

/** O menu de seleção do Discord aceita no máximo 25 opções. */
const SELECT_LIMIT = 25;

/**
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
async function isTomeManager(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const linked = await collections.members().findOne({ discordId: interaction.user.id });
  return MANAGER_GUILD_RANKS.includes(linked?.guildRank);
}

/**
 * Entrega um Tome a CADA pessoa selecionada, consumindo um crédito de missão
 * semanal de cada uma. Quem recebe sai da fila, mesmo que ainda tenha crédito.
 *
 * Aceita vários de uma vez porque a entrega é feita em mutirão: a staff distribui
 * para a fila inteira de uma sentada. Um clique por pessoa gerava uma resposta
 * efêmera por pessoa, e vinte entregas viravam vinte mensagens empilhadas na
 * tela de quem entregou.
 *
 * @param {string[]} uuids
 */
async function deliverTo(interaction, uuids) {
  const linhas = [];
  const ausentes = [];

  for (const uuid of uuids) {
    const entry = await collections.tomeQueue().findOne({ uuid });
    // Saiu da fila entre a abertura do menu e o clique (outra pessoa da staff
    // entregou, ou o próprio membro saiu). Não é erro — só não entrega.
    if (!entry) {
      ausentes.push(uuid);
      continue;
    }
    const { credits, delivered } = await deliverTome(uuid);
    await recordDelivery({
      kind: 'tome',
      uuid,
      username: entry.username,
      discordId: entry.discordId,
      byDiscordId: interaction.user.id,
    });
    linhas.push(tomeSummary({ username: entry.username, delivered, credits }));
  }

  await refreshPanels(interaction);

  if (!linhas.length) {
    return replyAndDismiss(interaction, {
      content: 'Ninguém da seleção continua na fila — nada entregue.',
      components: [],
    });
  }

  const cabecalho = `📜 **${linhas.length}** Tome(s) entregue(s). Saíram da fila.`;
  const rodape = ausentes.length ? `\n-# ${ausentes.length} já não estava(m) na fila e foram pulados.` : '';
  return replyAndDismiss(interaction, {
    content: `${cabecalho}\n${linhas.join('\n')}${rodape}`.slice(0, 2000),
    components: [],
  });
}

// --- Entrega de aspects (recompensa de guild raid, ao lado dos tomes) ---

/**
 * Passo 1: escolher quem recebeu, entre os que têm pendência.
 *
 * Marcando VÁRIOS, cada um recebe exatamente o que estava pendente — é o caso
 * normal, e não há o que digitar. Marcando UM SÓ, abre o modal para informar uma
 * quantidade diferente (entrega parcial, ou correção na hora).
 */
async function promptAspectDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Apenas **Chief ou superior** pode entregar aspects.', ephemeral: true });
  }
  const pending = await pendingAspects(interaction.guildId);
  if (!pending.length) return interaction.reply({ content: 'Ninguém tem aspects pendentes.', ephemeral: true });

  const opcoes = pending.slice(0, SELECT_LIMIT);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tome:aspectPick')
    .setPlaceholder('Quem recebeu aspects? (pode marcar vários)')
    .setMinValues(1)
    .setMaxValues(opcoes.length)
    .addOptions(
      opcoes.map((a) => ({
        label: a.username,
        value: a.uuid,
        description: `${fmtAsp(a.pending)} pendente(s)`,
      })),
    );
  return interaction.reply({
    content:
      'Selecione quem recebeu — pode marcar vários, e cada um recebe o que está pendente.\n' +
      '-# Marcando **uma** pessoa só, dá para informar uma quantidade diferente.',
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/**
 * Passo 2. Um selecionado: pergunta a quantidade. Vários: entrega o pendente de
 * cada um direto, sem modal — perguntar vinte vezes seria o mesmo spam de antes.
 */
async function promptAspectAmount(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.update({ content: 'Sem permissão.', components: [] });
  }

  if (interaction.values.length > 1) {
    await interaction.deferUpdate();
    return deliverAspectBatch(interaction, interaction.values);
  }

  const uuid = interaction.values[0];
  const a = (await pendingAspects(interaction.guildId)).find((x) => x.uuid === uuid);
  const modal = new ModalBuilder()
    .setCustomId(`tome:aspectAmount:${uuid}`)
    .setTitle('Entregar aspects')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('amount')
          .setLabel(`Quantidade (pendente: ${fmtAsp(a?.pending ?? 0)})`)
          .setPlaceholder('Ex.: 2 ou 0.5')
          .setStyle(TextInputStyle.Short)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

/**
 * Entrega, a cada selecionado, exatamente o que estava pendente. Recalcula na
 * hora: entre abrir o menu e clicar, alguém pode ter recebido por outra via.
 */
async function deliverAspectBatch(interaction, uuids) {
  const alvo = new Set(uuids);
  const pending = (await pendingAspects(interaction.guildId)).filter((a) => alvo.has(a.uuid));

  const linhas = [];
  let total = 0;
  for (const a of pending) {
    await deliverAspects(a.uuid, a.pending);
    const link = await collections.members().findOne({ uuid: a.uuid }, { projection: { discordId: 1 } });
    await recordDelivery({
      kind: 'aspect',
      uuid: a.uuid,
      username: a.username,
      discordId: link?.discordId ?? null,
      amount: a.pending,
      byDiscordId: interaction.user.id,
    });
    total += a.pending;
    linhas.push(`> **${a.username}** — ${fmtAsp(a.pending)} entregue(s), nada mais pendente.`);
  }

  await refreshPanels(interaction);

  if (!linhas.length) {
    return replyAndDismiss(interaction, {
      content: 'Ninguém da seleção tem pendência agora — nada entregue.',
      components: [],
    });
  }
  const pulados = uuids.length - linhas.length;
  return replyAndDismiss(interaction, {
    content:
      `✨ **${fmtAsp(total)}** aspect(s) entregues a **${linhas.length}** pessoa(s).\n` +
      linhas.join('\n') +
      (pulados ? `\n-# ${pulados} já não tinha(m) pendência e foram pulados.` : ''),
    components: [],
  });
}

/** Passo 3: aplica a entrega e atualiza o painel. */
async function applyAspectDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const uuid = interaction.customId.split(':')[2];
  const amount = Number(interaction.fields.getTextInputValue('amount').replace(',', '.'));
  if (!(amount > 0)) return interaction.editReply('Quantidade inválida. Use um número, ex.: `0.5`.');

  await deliverAspects(uuid, amount);
  // Depois da entrega: o resumo tem de refletir o estado novo, não o de antes.
  const status = await aspectStatus(interaction.guildId, uuid);
  const name = status?.username ?? uuid;
  // guildStats não guarda o Discord id — o vínculo mora em `members`.
  const link = await collections.members().findOne({ uuid }, { projection: { discordId: 1 } });
  await recordDelivery({
    kind: 'aspect',
    uuid,
    username: name,
    discordId: link?.discordId ?? null,
    amount,
    byDiscordId: interaction.user.id,
  });
  await refreshPanels(interaction);
  const resumo = aspectSummary(status);
  return replyAndDismiss(
    interaction,
    `✨ Entregue: **${fmtAsp(amount)}** aspect(s) a **${name}**.` + (resumo ? `\n${resumo}` : ''),
  );
}

/** Passo 1 do botão "Entregar Tome": escolher quem recebeu. */
async function promptDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Apenas **Chief ou superior** pode entregar Tomes.', ephemeral: true });
  }

  // Só quem cumpriu os dias de guilda E tem semanal de crédito pode receber —
  // os em espera nem aparecem no menu.
  const { ready } = await queueView(interaction.guildId);
  if (!ready.length) return interaction.reply({ content: 'Ninguém elegível na fila.', ephemeral: true });

  const opcoes = ready.slice(0, SELECT_LIMIT);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tome:delivered')
    .setPlaceholder('Quem recebeu o Tome? (pode marcar vários)')
    .setMinValues(1)
    // Marcar todo mundo de uma vez é o caso NORMAL: a staff distribui em
    // mutirão. O teto é o do Discord, não uma escolha nossa.
    .setMaxValues(opcoes.length)
    .addOptions(
      opcoes.map((r, i) => ({
        label: r.username,
        value: r.uuid,
        description: `${i + 1}º na fila · ${r.points} pts · direito a ${r.credits}`,
      })),
    );

  return interaction.reply({
    content: `Selecione quem recebeu — pode marcar vários. Consome um crédito de missão semanal de cada um.${ready.length > SELECT_LIMIT ? `\n-# Mostrando os ${SELECT_LIMIT} primeiros de ${ready.length}.` : ''}`,
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/** @param {import('discord.js').Interaction} interaction */
async function joinQueue(interaction) {
  const member = await collections.members().findOne({ discordId: interaction.user.id });
  if (!member) return interaction.editReply('Você precisa se registrar antes (canal de registro).');

  // Nível de classe é requisito de ENTRADA. Os dias de guilda, não: como nos
  // aspects, dá para entrar na fila antes e ela só passa a valer ao completar.
  const minLvl = await tomeMinLevel(interaction.guildId);
  const lvl = await maxClassLevel(member.username);
  if (lvl === null) {
    return interaction.editReply('Não consegui checar seu nível na API do Wynncraft agora. Tente de novo em instantes.');
  }
  if (lvl < minLvl) {
    return interaction.editReply(`A fila de Tomes exige uma classe **nível ${minLvl}**. Sua classe mais alta é **${lvl}**.`);
  }

  await collections.tomeQueue().updateOne(
    { uuid: member.uuid },
    {
      $set: { uuid: member.uuid, discordId: member.discordId, username: member.username },
      $setOnInsert: { joinedQueueAt: new Date() },
    },
    { upsert: true },
  );

  const { ready, waiting, minDays: min } = await queueView(interaction.guildId);
  await ensureTomePanel(interaction.client, interaction.guildId);

  // Está na fila, mas em espera — só aparece de fato quando destravar. Os dados
  // vêm da mesma fonte do painel, para a mensagem nunca discordar dele.
  const own = waiting.find((r) => r.uuid === member.uuid);
  if (own) {
    if (own.blockedBy === 'weekly') {
      return interaction.editReply(
        'Você entrou na fila de Tomes! Mas ela só passa a valer quando você cumprir a **missão semanal da guilda** — cada semanal dá direito a **1 Tome**, e acumula.\n' +
          '-# Até lá você não aparece na fila.',
      );
    }
    return interaction.editReply(
      own.days === null
        ? `Você entrou na fila de Tomes, mas ela só passa a valer quando eu confirmar sua entrada na guilda **Wynn Brasil** e você completar **${min} dias** nela.`
        : `Você entrou na fila de Tomes! Mas ela só passa a valer com **${min} dias** de guilda — você está há **${own.days}**, faltam **${min - own.days}**.\n-# Até lá você não aparece na fila, mas já pode ir acumulando pontos e missões semanais.`,
    );
  }

  const entry = ready.find((r) => r.uuid === member.uuid);
  const pos = ready.indexOf(entry) + 1;
  return interaction.editReply(
    `Você entrou na fila de Tomes! Posição atual: **${pos}** de ${ready.length} — direito a **${entry.credits} Tome(s)**.\n-# A fila é ordenada por pontos de contribuição, não por ordem de chegada.`,
  );
}

/** @param {import('discord.js').Interaction} interaction */
async function leaveQueue(interaction) {
  const member = await collections.members().findOne({ discordId: interaction.user.id });
  if (!member) return interaction.editReply('Você não está registrado.');
  const res = await collections.tomeQueue().deleteOne({ uuid: member.uuid });
  if (res.deletedCount) await ensureTomePanel(interaction.client, interaction.guildId);
  return interaction.editReply(res.deletedCount ? 'Você saiu da fila de Tomes.' : 'Você não estava na fila.');
}

/** @param {import('discord.js').Interaction} interaction */
async function showQueue(interaction) {
  const { ready, waiting, minDays } = await queueView(interaction.guildId);
  if (!ready.length && !waiting.length) return interaction.editReply('A fila de Tomes está vazia.');
  const lines = ready
    .slice(0, 15)
    .map((r, i) => `\`${String(i + 1).padStart(2, ' ')}\` **${r.username}** — ${r.points} pts · ${r.credits}× 📜`);
  if (!ready.length) lines.push('_Ninguém elegível ainda._');
  // Em espera aparecem à parte: estão na fila, mas ainda não valem.
  if (waiting.length) {
    lines.push(
      '',
      `**Em espera (${waiting.length})**`,
      ...waiting.slice(0, 10).map((r) => {
        const motivo =
          r.blockedBy === 'weekly'
            ? 'sem missão semanal'
            : r.days === null
              ? 'entrada na guilda não confirmada'
              : `${r.days}/${minDays} dias de guilda`;
        return `-# **${r.username}** — ${motivo}`;
      }),
    );
  }
  return interaction.editReply({
    embeds: [
      {
        title: '📜 Fila de Tomes',
        description: lines.join('\n'),
        color: 0x9b59b6,
        footer: { text: `${ready.length} na fila · por pontos · 1 tome por missão semanal` },
      },
    ],
  });
}

export default {
  data: new SlashCommandBuilder()
    .setName('tome')
    .setDescription('Fila de Tomes da guilda')
    .addSubcommand((s) => s.setName('join').setDescription('Entra na fila de Tomes'))
    .addSubcommand((s) => s.setName('leave').setDescription('Sai da fila de Tomes'))
    .addSubcommand((s) => s.setName('queue').setDescription('Mostra a fila (ordenada por pontos)'))
    .addSubcommand((s) =>
      s
        .setName('grant')
        .setDescription('(Staff) Concede um Tome e remove da fila')
        .addUserOption((o) => o.setName('user').setDescription('Quem recebeu (padrão: topo da fila)').setRequired(false)),
    )
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('tome:');
  },

  async handleComponent(interaction) {
    const action = interaction.customId.split(':')[1];

    if (action === 'deliver') return promptDelivery(interaction);
    if (action === 'delivered') {
      if (!(await isTomeManager(interaction))) {
        return interaction.update({ content: 'Sem permissão.', components: [] });
      }
      await interaction.deferUpdate();
      return deliverTo(interaction, interaction.values);
    }

    // Entrega de aspects: botão → select → modal.
    if (action === 'deliverAspect') return promptAspectDelivery(interaction);
    if (action === 'aspectPick') return promptAspectAmount(interaction);
    if (action === 'aspectAmount') return applyAspectDelivery(interaction);

    if (!BUTTON_ACTIONS.includes(action)) return;
    await interaction.deferReply({ ephemeral: true });
    // Confirmação de membro: descartável como a da staff, só com mais tempo —
    // o texto explica regras (dias de guilda, missão semanal) que a pessoa pode
    // querer reler antes de sumir. A fila de verdade está no painel.
    const res = action === 'join' ? await joinQueue(interaction) : await leaveQueue(interaction);
    autoDismiss(interaction, DISMISS.member);
    return res;
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: sub !== 'queue' });

    // `/tome queue` é o único que a pessoa pediu para LER — esse fica. Os outros
    // são confirmações, e somem como as do painel.
    if (sub === 'join') {
      const res = await joinQueue(interaction);
      autoDismiss(interaction, DISMISS.member);
      return res;
    }
    if (sub === 'leave') {
      const res = await leaveQueue(interaction);
      autoDismiss(interaction, DISMISS.member);
      return res;
    }
    if (sub === 'queue') return showQueue(interaction);

    // grant (staff)
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.editReply('Apenas staff pode conceder Tomes.');
    }
    const user = interaction.options.getUser('user');
    const { ready, minDays } = await queueView(interaction.guildId);
    let target;
    if (user) {
      const member = await collections.members().findOne({ discordId: user.id });
      if (!member) return interaction.editReply('Esse usuário não está vinculado.');
      target = ready.find((r) => r.uuid === member.uuid);
      if (!target) {
        const inQueue = await collections.tomeQueue().findOne({ uuid: member.uuid });
        if (!inQueue) return interaction.editReply('Esse usuário não está na fila.');
        const stat = await collections
          .guildStats()
          .findOne({ uuid: member.uuid }, { projection: { weeklyObjectives: 1, tomesDelivered: 1 } });
        return interaction.editReply(
          tomeCredits(stat) <= 0
            ? 'Esse usuário está na fila, mas não tem missão semanal de crédito — cada semanal dá direito a 1 Tome.'
            : `Esse usuário está na fila, mas ainda não completou **${minDays} dias** de guilda.`,
        );
      }
    } else {
      if (!ready.length) return interaction.editReply('Ninguém elegível na fila.');
      target = ready[0];
    }
    const { credits, delivered } = await deliverTome(target.uuid);
    await recordDelivery({
      kind: 'tome',
      uuid: target.uuid,
      username: target.username,
      discordId: target.discordId,
      byDiscordId: interaction.user.id,
    });
    await refreshPanels(interaction);
    return replyAndDismiss(
      interaction,
      `📜 Tome concedido a **${target.username}**. Saiu da fila.\n` +
        tomeSummary({ username: target.username, delivered, credits }),
    );
  },
};
