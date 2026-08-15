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
 * Mesmo formato da fila — "X de Y" — para o número não mudar de significado
 * entre um lugar e outro.
 *
 * A fila vale por UM: receber tira da fila mesmo quem ainda tem direito a mais,
 * então a linha precisa dizer o que fazer para pegar o próximo. Não há espera
 * nenhuma para reentrar; basta ter direito.
 */
function tomeSummary({ username, delivered, entitled, credits }) {
  const total = `**${username}** — **${delivered}** de **${entitled}** Tome(s) a que tem direito`;
  return credits > 0
    ? `> ${total} · faltam **${credits}**, e a fila vale por 1 — é só entrar de novo, sem espera.`
    : `> ${total} · nada a receber agora; cada missão semanal cumprida dá direito a mais 1.`;
}

/**
 * Como está o saldo da pessoa DEPOIS da entrega. São três estados de verdade
 * diferentes, e confundi-los é o que faz a staff entregar duas vezes:
 *
 *  - ainda tem unidade inteira a receber;
 *  - só sobrou fração, que não dá para entregar e fica acumulando;
 *  - ficou devendo, porque recebeu a mais.
 */
function saldoLabel(status) {
  if (!status) return 'saldo desconhecido';
  if (status.pending < 0) return `⚠️ recebeu ${fmtAsp(-status.pending)} a mais — as próximas raids quitam`;
  if (status.deliverable >= 1) return `ainda faltam **${status.deliverable}**`;
  if (status.pending > 0) return `sobrou ${fmtAsp(status.pending)} acumulando`;
  return 'nada pendente';
}

/** O acumulado de vida da pessoa em aspects, para a confirmação da staff. */
function aspectSummary(status) {
  if (!status) return null;
  return `> **${status.username}** já recebeu **${fmtAsp(status.delivered)}** aspect(s) · ${saldoLabel(status)}.`;
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

// O modal do Discord aceita no máximo 5 campos de texto. Como a entrega de
// aspects exige a staff informar quanto entregou a CADA um, o lote de aspects
// para em 5 — não é escolha nossa, é o teto da plataforma.
const MODAL_FIELD_LIMIT = 5;

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
    const { credits, delivered, entitled } = await deliverTome(uuid);
    await recordDelivery({
      kind: 'tome',
      uuid,
      username: entry.username,
      discordId: entry.discordId,
      byDiscordId: interaction.user.id,
    });
    linhas.push(tomeSummary({ username: entry.username, delivered, entitled, credits }));
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
 * Passo 1: escolher quem recebeu, entre os que têm unidade inteira a receber.
 *
 * O teto de 5 não é escolha nossa: o modal do Discord aceita no máximo 5 campos,
 * e cada pessoa precisa do seu — a staff informa quanto entregou DE VERDADE, que
 * pode ser mais do que o saldo (no jogo se passa a mais, e isso vira saldo
 * negativo que as próximas raids quitam).
 */
async function promptAspectDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Apenas **Chief ou superior** pode entregar aspects.', ephemeral: true });
  }
  const pending = await pendingAspects(interaction.guildId);
  if (!pending.length) {
    return interaction.reply({
      content: 'Ninguém tem aspect inteiro a receber.\n-# Quem tem só meio acumulado aparece no `/aspects`, mas não dá para entregar meio aspect.',
      ephemeral: true,
    });
  }

  const opcoes = pending.slice(0, MODAL_FIELD_LIMIT);
  const menu = new StringSelectMenuBuilder()
    .setCustomId('tome:aspectPick')
    .setPlaceholder(`Quem recebeu aspects? (até ${MODAL_FIELD_LIMIT})`)
    .setMinValues(1)
    .setMaxValues(opcoes.length)
    .addOptions(
      opcoes.map((a) => ({
        label: a.username,
        value: a.uuid,
        description: `${a.deliverable} a entregar`,
      })),
    );
  const sobra = pending.length - opcoes.length;
  return interaction.reply({
    content:
      `Selecione quem recebeu — até **${MODAL_FIELD_LIMIT}** por vez. Em seguida você informa quanto entregou a cada um.` +
      (sobra ? `\n-# Mais ${sobra} na fila; entregue em rodadas.` : ''),
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  });
}

/**
 * Passo 2: um campo por pessoa selecionada, já preenchido com o que ela tem a
 * receber. A staff edita quem precisar — inclusive para MAIS, e deixar em branco
 * (ou zero) pula aquela pessoa.
 *
 * Os uuids vão no customId porque o modal não carrega estado próprio, e a ordem
 * dos campos precisa casar com a ordem deles na hora de aplicar.
 */
async function promptAspectAmount(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.update({ content: 'Sem permissão.', components: [] });
  }

  const escolhidos = interaction.values.slice(0, MODAL_FIELD_LIMIT);
  const pending = await pendingAspects(interaction.guildId);
  const alvos = escolhidos.map((uuid) => pending.find((a) => a.uuid === uuid)).filter(Boolean);
  if (!alvos.length) {
    return interaction.update({ content: 'Ninguém da seleção tem aspect inteiro a receber agora.', components: [] });
  }

  const modal = new ModalBuilder()
    .setCustomId(`tome:aspectAmount:${alvos.map((a) => a.uuid).join(',')}`)
    .setTitle('Entregar aspects')
    .addComponents(
      ...alvos.map((a) =>
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId(`amt:${a.uuid}`)
            // O label do Discord vai a 45 caracteres; nick vai a 20, então cabe.
            .setLabel(`${a.username} (a receber: ${a.deliverable})`.slice(0, 45))
            .setValue(String(a.deliverable))
            .setPlaceholder('Unidades inteiras. 0 ou vazio = pular')
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      ),
    );
  return interaction.showModal(modal);
}

/**
 * Passo 3: aplica o que a staff digitou, um campo por pessoa.
 *
 * Aceita MAIS do que o saldo de propósito: no jogo se entrega a mais, e o
 * excedente vira saldo negativo que as próximas raids quitam (ver a nota no topo
 * de services/aspects.js). O que NÃO se aceita é fração — aspect é item inteiro.
 */
async function applyAspectDelivery(interaction) {
  if (!(await isTomeManager(interaction))) {
    return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });

  const uuids = interaction.customId.split(':')[2].split(',').filter(Boolean);

  const entregues = [];
  const invalidos = [];
  let total = 0;

  for (const uuid of uuids) {
    const bruto = (interaction.fields.getTextInputValue(`amt:${uuid}`) ?? '').trim();
    const status = await aspectStatus(interaction.guildId, uuid);
    const nome = status?.username ?? uuid;

    // Vazio ou zero = a staff decidiu não entregar a essa pessoa agora.
    if (!bruto || bruto === '0') continue;

    const valor = Number(bruto.replace(',', '.'));
    if (!Number.isInteger(valor) || valor <= 0) {
      invalidos.push(`**${nome}**: \`${bruto}\``);
      continue;
    }

    await deliverAspects(uuid, valor);
    const link = await collections.members().findOne({ uuid }, { projection: { discordId: 1 } });
    await recordDelivery({
      kind: 'aspect',
      uuid,
      username: nome,
      discordId: link?.discordId ?? null,
      amount: valor,
      byDiscordId: interaction.user.id,
    });
    total += valor;
    // Relê DEPOIS da entrega: o resumo tem de refletir o estado novo.
    entregues.push({ valor, status: await aspectStatus(interaction.guildId, uuid) });
  }

  await refreshPanels(interaction);

  const aviso = invalidos.length
    ? `\n⚠️ Ignorado (não é unidade inteira): ${invalidos.join(', ')}.`
    : '';

  if (!entregues.length) {
    return replyAndDismiss(interaction, `Nada entregue.${aviso}`, DISMISS.member);
  }

  const linhas = entregues.map((e) => `> **${e.status?.username ?? '?'}** — ${e.valor} entregue(s) · ${saldoLabel(e.status)}`);
  return replyAndDismiss(
    interaction,
    `✨ **${total}** aspect(s) entregue(s) a **${entregues.length}** pessoa(s).\n${linhas.join('\n')}${aviso}`,
    aviso ? DISMISS.member : DISMISS.delivery,
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
        description: `${i + 1}º · ${r.points} pts · ${r.delivered}/${r.entitled} recebidos`.slice(0, 100),
      })),
    );

  return interaction.reply({
    content: `Selecione quem recebeu — pode marcar vários. Cada um leva **1 Tome** e sai da fila; quem ainda tiver direito entra de novo, sem espera.${ready.length > SELECT_LIMIT ? `\n-# Mostrando os ${SELECT_LIMIT} primeiros de ${ready.length}.` : ''}`,
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
  // A regra que mais gera dúvida: a fila vale por UM. Quem tem direito a mais de
  // um não recebe tudo de uma vez — recebe, sai, e entra de novo na hora.
  const maisDeUm =
    entry.credits > 1
      ? `\n-# A fila vale por **1 Tome**. Você tem direito a ${entry.credits}; depois de receber, entre de novo — não há espera.`
      : '';
  return interaction.editReply(
    `Você entrou na fila de Tomes! Posição atual: **${pos}** de ${ready.length} — já recebeu **${entry.delivered}** de **${entry.entitled}** a que tem direito.\n` +
      `-# A fila é ordenada por pontos de contribuição, não por ordem de chegada.${maisDeUm}`,
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
  // Mesmo formato do painel: nome e, sob ele, o acumulado de vida.
  const lines = ready
    .slice(0, 15)
    .flatMap((r, i) => [
      `\`${String(i + 1).padStart(2, ' ')}\` **${r.username}** — ${r.points} pts`,
      `> já recebeu **${r.delivered}** de **${r.entitled}** 📜 a que tem direito`,
    ]);
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
    const { credits, delivered, entitled } = await deliverTome(target.uuid);
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
        tomeSummary({ username: target.username, delivered, entitled, credits }),
    );
  },
};
