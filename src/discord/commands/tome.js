import { SlashCommandBuilder, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { collections } from '../../db/mongo.js';
import {
  queueView,
  deliverTome,
  tomeCredits,
  ensureTomePanel,
  adjustTomesDelivered,
  setTomesDelivered,
  tomeStatus,
} from '../../services/tomes.js';
import { recordDelivery } from '../../services/rewardLog.js';
import { maxClassLevel, tomeMinLevel } from '../../services/eligibility.js';
import { audit } from '../../services/audit.js';
import { autoDismiss, DISMISS } from '../../util/ephemeral.js';
import { LEVEL, hasLevel, deniedMessage } from '../../services/permissions.js';

/**
 * Republica o painel de Tomes, que traz a fila e as últimas entregas.
 *
 * Substituiu o anúncio por entrega. Antes, cada Tome virava uma mensagem nova
 * no canal — para o premiado (com ping) e à vista de todos —, e 24h depois a
 * limpeza apagava tudo, sem deixar registro de quem recebeu o quê. Agora a
 * entrega vira uma linha no log do painel, que é EDITADO: não pinga ninguém,
 * não empurra o canal para baixo, e o extrato fica.
 */
async function refreshPanels(interaction) {
  await ensureTomePanel(interaction.client, interaction.guildId);
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
  if (credits > 0) return `> ${total} · faltam **${credits}**, e a fila vale por 1 — é só entrar de novo, sem espera.`;
  // Recebeu além do direito: sem isto, "8 de 3" parece bug em vez de excedente.
  if (delivered > entitled) {
    return `> ${total} · ⚠️ recebeu **${delivered - entitled}** a mais — não entra na fila até as próximas missões semanais quitarem isso.`;
  }
  return `> ${total} · nada a receber agora; cada missão semanal cumprida dá direito a mais 1.`;
}

/**
 * `/tome corrigir`: o mesmo conserto do /aspects, para Tomes entregues fora do
 * bot ou registrados errado.
 *
 * `ajustar` soma ou tira sem precisar saber o acumulado (+5 = entreguei 5 e não
 * registrei); `entregues` reescreve o total quando se sabe o número certo. Sem
 * nenhum dos dois, só mostra como a pessoa está — é o que se precisa ver antes
 * de usar `entregues`.
 */
async function correctTomes(interaction) {
  // Corrigir reescreve o contador: é de Chefe (Staff), não de quem só entrega.
  if (!hasLevel(interaction.member, LEVEL.CHEFE)) return interaction.editReply(deniedMessage(LEVEL.CHEFE));
  const user = interaction.options.getUser('user', true);
  const ajustar = interaction.options.getInteger('ajustar');
  const corrigir = interaction.options.getInteger('entregues');

  const link = await collections.members().findOne({ discordId: user.id });
  if (!link) return interaction.editReply(`<@${user.id}> não está vinculado a nenhuma conta.`);

  if (ajustar !== null && corrigir !== null) {
    return interaction.editReply('Use **uma** das duas: `ajustar` (quanto somar ou tirar) ou `entregues` (o total certo).');
  }
  if (ajustar === null && corrigir === null) {
    const st = await tomeStatus(link.uuid);
    return interaction.editReply(
      `${tomeSummary({ username: link.username, ...st })}\n` +
        '-# Para corrigir: `ajustar:5` soma 5 entregues fora do bot · `ajustar:-2` tira 2 · `entregues:8` reescreve o total para 8.',
    );
  }
  if (ajustar === 0) {
    return interaction.editReply('Ajustar zero não faz nada. Use um número com sinal, ex.: `5` para somar 5 ou `-2` para tirar 2.');
  }

  const res =
    ajustar !== null ? await adjustTomesDelivered(link.uuid, ajustar) : await setTomesDelivered(link.uuid, corrigir);
  const st = await tomeStatus(link.uuid);

  // Toda correção tira da fila, como uma entrega: a posição dela foi pedida com
  // a conta antiga. Quem ainda tiver direito entra de novo; quem ficou com
  // excedente é barrado na entrada (ver joinQueue).
  const saiu = (await collections.tomeQueue().deleteOne({ uuid: link.uuid })).deletedCount > 0;

  await audit(
    interaction.client,
    interaction.guildId,
    `✏️ <@${interaction.user.id}> corrigiu os Tomes entregues de **${link.username}**: ` +
      `${res.antes} → **${res.agora}** (direito ${st.entitled}).`,
  );
  await ensureTomePanel(interaction.client, interaction.guildId).catch(() => null);

  return interaction.editReply(
    `✏️ **${link.username}** — Tomes entregues: ${res.antes} → **${res.agora}**\n` +
      tomeSummary({ username: link.username, ...st }) +
      (saiu ? '\n-# 🚪 Foi tirado da fila.' : '') +
      (st.excess > 0 ? `\n-# 🚫 Bloqueado de entrar na fila até cumprir mais ${st.excess} semanal(is).` : ''),
  );
}

// Ações abertas a qualquer membro. `queue` saiu daqui junto com o botão "Ver
// fila": a fila já está no painel, e o botão só produzia uma cópia efêmera dela.
// O `/tome queue` continua existindo — quem digita o comando está pedindo, não
// sendo bombardeado.
/** @type {readonly string[]} */
const BUTTON_ACTIONS = Object.freeze(['join', 'leave']);

/** O menu de seleção do Discord aceita no máximo 25 opções. */
const SELECT_LIMIT = 25;

/**
 * Quem entrega recompensa: Tomes, aspects e esmeraldas (ver
 * discord/raidRewardCommand.js). Qualquer cargo da Staff (ver services/permissions.js).
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>}
 */
export async function isRewardManager(interaction) {
  return hasLevel(interaction.member, LEVEL.STAFF);
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

/** Passo 1 do botão "Entregar Tome": escolher quem recebeu. */
async function promptDelivery(interaction) {
  if (!(await isRewardManager(interaction))) {
    return interaction.reply({ content: 'Apenas a **Staff** pode entregar Tomes.', ephemeral: true });
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

  // Quem recebeu MAIS Tomes do que tem direito não entra, nem em espera. Sem
  // crédito normal a pessoa pode entrar e aguardar a próxima semanal; com
  // excedente ela ainda deve semanais, e esperar na fila só a faria parecer
  // perto de receber. Checado antes da API: é barato e definitivo.
  const st = await tomeStatus(member.uuid);
  if (st.excess > 0) {
    return interaction.editReply(
      `Você já recebeu **${st.delivered}** Tome(s), **${st.excess}** a mais do que as **${st.entitled}** missões semanais dão direito.\n` +
        `-# Só dá para entrar na fila de novo depois de cumprir mais **${st.excess}** missão(ões) semanal(is).`,
    );
  }

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
    .addSubcommand((s) =>
      s
        .setName('corrigir')
        .setDescription('(Staff) Corrige os Tomes já entregues a um jogador')
        .addUserOption((o) => o.setName('user').setDescription('Jogador a corrigir').setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName('ajustar')
            .setDescription('Tomes a MAIS (+5) ou a MENOS (-2) no já entregue')
            .setRequired(false),
        )
        .addIntegerOption((o) =>
          o
            .setName('entregues')
            .setDescription('Novo TOTAL de Tomes já entregues a esse jogador')
            .setMinValue(0)
            .setRequired(false),
        ),
    )
    .toJSON(),

  owns(interaction) {
    return typeof interaction.customId === 'string' && interaction.customId.startsWith('tome:');
  },

  async handleComponent(interaction) {
    const action = interaction.customId.split(':')[1];

    if (action === 'deliver') return promptDelivery(interaction);
    if (action === 'delivered') {
      if (!(await isRewardManager(interaction))) {
        return interaction.update({ content: 'Sem permissão.', components: [] });
      }
      await interaction.deferUpdate();
      return deliverTo(interaction, interaction.values);
    }

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
    if (sub === 'corrigir') return correctTomes(interaction);

    // grant (staff)
    if (!(await isRewardManager(interaction))) return interaction.editReply(deniedMessage(LEVEL.STAFF));
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
