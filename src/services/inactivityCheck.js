import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { fetchGuildMembers } from './guildData.js';
import { evaluate } from './inactivity.js';
import { audit } from './audit.js';
import { log } from '../util/log.js';

/**
 * Check-in de inatividade.
 *
 * Quando alguém estoura a própria margem (base + perdão comprado com pontos —
 * ver services/inactivity.js), o bot manda UMA mensagem no privado perguntando se
 * a pessoa perdeu o interesse ou só não está conseguindo entrar. Sem resposta em
 * `inactivityCheckHours`, o silêncio conta como desinteresse e o nick entra na
 * lista de `/gu kick` do /verificar.
 *
 * Por que perguntar antes de expulsar: o kick por inatividade não é punição — a
 * guilda tem um número fixo de slots, e slot parado é slot que um membro ativo
 * não pode ocupar.
 *
 * Dizer "ainda quero jogar" não é um passe livre: compra `inactivityReturnDays`
 * para ENTRAR no jogo. Quem entra zera o contador sozinho (o login renova o
 * `lastJoin` na API, o membro deixa de ser expulsável e o check-in é
 * descartado). Quem não entra cai na lista de kick igual a quem não respondeu —
 * senão bastaria clicar num botão para segurar um slot parado para sempre.
 *
 * No máximo DUAS mensagens por episódio, nunca uma cobrança recorrente:
 *   1. o check-in, quando a margem estoura;
 *   2. só para quem clicou em "ainda quero jogar" e deixou o prazo vencer sem
 *      logar — avisando que o nick caiu na lista da staff.
 * Quem não respondeu nada não recebe a segunda: silêncio já é resposta, e
 * insistir é exatamente o que a primeira mensagem promete não fazer.
 *
 * O registro só é apagado quando a pessoa volta a jogar (ou ganha margem nova),
 * e é isso que permite perguntar outra vez numa inatividade futura sem nunca
 * insistir na atual.
 *
 * @typedef {'pending'|'stay'|'quit'|'unreachable'} CheckStatus
 *   pending     — perguntamos e estamos dentro do prazo de resposta
 *   stay        — clicou em "Ainda quero jogar"; corre o prazo para logar
 *   quit        — clicou em "Perdi o interesse"
 *   unreachable — sem vínculo no Discord, ou DM fechada: não deu para perguntar
 *
 * `farewellSentAt` marca que a segunda mensagem já foi tentada, para o job não
 * reenviá-la a cada hora enquanto a staff não roda a lista.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Prefixo dos botões da DM; o /verificar é quem roteia (ver verificar.js). */
export const BUTTON_PREFIX = 'inativo:';

/**
 * Teto de DMs por volta do job. Abrir canal de DM é uma das rotas mais
 * limitadas do Discord, e o primeiro ciclo depois de subir a feature encontra a
 * fila inteira acumulada. Como o job roda de hora em hora, o resto sai na volta
 * seguinte — ninguém fica sem ser perguntado, só não sai tudo de uma vez.
 */
const MAX_DMS_PER_RUN = 20;

/** Respiro entre duas DMs, pelo mesmo motivo do teto acima. */
const DM_GAP_MS = 1_500;

/** Canal de recrutamento citado no texto — mesmo id fixo de staticPanels.js. */
const RECRUIT_CHANNEL = '1309848293278486578';

/** Como cada estado aparece no relatório da staff. */
const REASON = Object.freeze({
  quit: 'sem interesse',
  pending: 'não respondeu',
  stay: 'disse que voltaria e não logou',
  unreachable: 'não recebe DM',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

/** Prazo de resposta ao check-in. @returns {number} */
function waitMs(params) {
  return (Number(params?.inactivityCheckHours) || 24) * HOUR_MS;
}

/** Prazo para logar depois de responder "ainda quero jogar". @returns {number} */
function returnMs(params) {
  return (Number(params?.inactivityReturnDays) || 0) * DAY_MS;
}

/** @param {string} uuid @returns {ActionRowBuilder} */
function buttons(uuid) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}stay:${uuid}`)
      .setLabel('Ainda quero jogar')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BUTTON_PREFIX}quit:${uuid}`)
      .setLabel('Perdi o interesse')
      .setEmoji('👋')
      .setStyle(ButtonStyle.Secondary),
  );
}

/**
 * A mensagem do check-in. Um pedido de sinal, não um ultimato: o texto diz o
 * número real (dias offline × margem), explica que o kick existe para liberar
 * slot, e deixa claro que a volta é livre.
 *
 * @param {{guildName: string, uuid: string, deadline: Date, r: object, params: object}} ctx
 */
function checkInPayload({ guildName, uuid, deadline, r, params }) {
  const prazo = unix(deadline);
  const base = Number(params?.inactivityDays) || 0;
  const volta = Number(params?.inactivityReturnDays) || 0;
  const perdao = r.forgiveness
    ? ` (${base} de base + ${r.forgiveness} que seus ${r.points} pontos de contribuição compraram)`
    : '';

  return {
    embeds: [
      {
        title: '👋 Você ainda quer jogar Wynncraft com a gente?',
        color: 0xf1c40f,
        description:
`Você está há **${r.offline} dias** sem entrar no jogo, e a sua margem de inatividade é de **${r.allowance} dias**${perdao}. Ou seja: o limite chegou.

**Isto não é punição e não é banimento.** A expulsão por inatividade existe por um motivo só: a guilda tem um número limitado de slots, e um slot parado é um slot que um membro ativo não pode ocupar. Nada fica no seu histórico, e **você pode voltar quando quiser** — é só refazer o processo em <#${RECRUIT_CHANNEL}>.

Só precisamos saber em que pé você está:

> 🎮 **Ainda quero jogar** — a vida acontece, e nem sempre dá para entrar. Aí você tem **${volta} dias** para dar as caras no jogo: um login já zera o contador e o assunto morre.
> 👋 **Perdi o interesse** — liberamos o seu slot agora, sem ressentimento.

Se ninguém clicar até <t:${prazo}:f> (<t:${prazo}:R>), vamos considerar que você seguiu em frente e liberar a vaga.

-# Não vamos ficar te cobrando: sem resposta, esta é a **única** mensagem que você recebe sobre isso.`,
        footer: { text: `${guildName} — sair por inatividade não fecha a porta.` },
        timestamp: new Date().toISOString(),
      },
    ],
    components: [buttons(uuid)],
  };
}

/**
 * A mesma mensagem depois de respondida: sem botões, com a decisão registrada.
 * @param {'stay'|'quit'} status
 * @param {Date} [returnBy]  prazo para logar, quando a resposta foi "stay"
 */
function answeredPayload(status, returnBy) {
  const fim = status === 'stay'
    ? {
        title: '🎮 Anotado: a vaga é sua',
        color: 0x2ecc71,
        description:
`Beleza! A staff foi avisada e ninguém vai te expulsar agora.

**Só falta a parte que depende de você:** entre no jogo até <t:${unix(returnBy)}:f> (<t:${unix(returnBy)}:R>). Um login já basta — o contador zera sozinho e o assunto morre aqui.

Se o prazo passar sem nenhum login, eu te aviso **uma última vez** e a vaga volta para a fila: um slot só está de fato ocupado por quem joga. Mesmo aí, você continua podendo voltar depois — sem banimento e sem ressentimento.

-# Quando conseguir jogar de verdade, **objetivo semanal** é o que mais rende ponto por tempo gasto — e ponto vira margem de inatividade.`,
      }
    : {
        title: '👋 Tudo certo — seu slot foi liberado',
        color: 0x95a5a6,
        description:
`Obrigado por avisar! A vaga vai para alguém que está jogando agora, que é exatamente para isso que ela serve.

**A porta continua aberta.** Isto não é banimento: quando bater a vontade de voltar, é só refazer o processo em <#${RECRUIT_CHANNEL}>. Boa jornada. 🫡`,
      };

  return { embeds: [{ ...fim, timestamp: new Date().toISOString() }], components: [] };
}

/**
 * Segunda (e última) mensagem, só para quem clicou em "ainda quero jogar" e
 * deixou o prazo passar sem logar. Avisar aqui é o que impede a surpresa: a
 * pessoa se comprometeu, e merece saber que o compromisso venceu antes de o
 * nick aparecer na lista da staff.
 *
 * Ainda dá tempo, e o texto diz isso: a expulsão não é automática, alguém
 * precisa rodar a lista. Um login antes disso apaga o check-in e tira o nome.
 *
 * @param {{params: object}} ctx
 */
function farewellPayload({ params }) {
  const volta = Number(params?.inactivityReturnDays) || 0;
  return {
    embeds: [
      {
        title: '⏳ O prazo acabou — seu nick foi para a lista',
        color: 0xe67e22,
        description:
`Você disse que ainda queria jogar e a gente segurou a sua vaga por **${volta} dias**. O prazo passou sem nenhum login, então seu nome entrou na lista de liberação de slot da staff.

**Ainda dá tempo.** A expulsão não é automática: alguém da staff precisa rodar a lista. Se você entrar no jogo antes disso, o contador zera sozinho e seu nome sai na hora.

E se não rolar, tudo bem — de novo: **não é banimento e não fica no seu histórico.** Quando quiser voltar, é só refazer o processo em <#${RECRUIT_CHANNEL}>.

-# Última mensagem automática sobre isso. Prometido.`,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Envia uma DM. Falha calada de propósito: DM fechada é uma resposta em si
 * (`unreachable`), tratada por quem chama.
 * @returns {Promise<boolean>} true se a mensagem saiu
 */
async function sendDM(client, discordId, payload) {
  const user = await client.users.fetch(discordId).catch(() => null);
  if (!user) return false;
  const msg = await user.send(payload).catch(() => null);
  return !!msg;
}

/**
 * Pergunta a quem acabou de estourar a margem, e limpa o que não vale mais.
 * @param {import('discord.js').Client} client
 * @returns {Promise<void>}
 */
export async function runInactivityCheck(client) {
  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const prefix = optional('WYNN_GUILD_PREFIX');
  if (!guildDiscordId || !prefix) return;

  const res = await fetchGuildMembers(prefix);
  if (!res) return;

  const { params } = await getConfig(guildDiscordId);
  const checks = collections.inactivityChecks();
  const [stats, saved, links] = await Promise.all([
    collections.guildStats().find({}, { projection: { uuid: 1, points: 1 } }).toArray(),
    checks.find({}).toArray(),
    collections
      .members()
      .find({}, { projection: { uuid: 1, discordId: 1, classification: 1 } })
      .toArray(),
  ]);
  const pointsByUuid = new Map(stats.map((s) => [s.uuid, s.points ?? 0]));
  const checkByUuid = new Map(saved.map((c) => [c.uuid, c]));
  const linkByUuid = new Map(links.map((l) => [l.uuid, l]));

  const now = Date.now();
  let tentativas = 0; // orçamento de DMs da volta (perguntas + avisos de prazo)
  let perguntas = 0;
  let avisos = 0;
  let semDM = 0;

  for (const m of res.members) {
    const link = linkByUuid.get(m.uuid);
    // Banido é decisão tomada, não pergunta em aberto — o /verificar já o ignora.
    if (link?.classification === 'banned') continue;

    const r = evaluate(m, pointsByUuid.get(m.uuid) ?? 0, params);
    const prev = checkByUuid.get(m.uuid);

    // Voltou a jogar, ou contribuiu o bastante para comprar margem nova: o
    // episódio acabou. É este ramo que "reseta o contador" de quem prometeu
    // voltar e voltou — o login renova o `lastJoin` e o check-in é descartado.
    // Apagar aqui é também o que permite perguntar de novo numa inatividade
    // FUTURA sem nunca insistir na atual.
    if (!r.kickable) {
      if (prev) await checks.deleteOne({ uuid: m.uuid });
      continue;
    }

    // Já perguntado neste episódio. A regra é uma mensagem por episódio; a
    // ÚNICA exceção é quem prometeu voltar e furou o prazo — esse recebe a
    // segunda e última, avisando que caiu na lista. Quem não respondeu nada não
    // ganha uma segunda: silêncio já é resposta, e insistir é o que a gente
    // prometeu não fazer.
    if (prev) {
      const venceu = prev.status === 'stay'
        && !prev.farewellSentAt
        && now >= new Date(prev.respondedAt ?? prev.sentAt).getTime() + returnMs(params);
      if (venceu && prev.discordId && tentativas < MAX_DMS_PER_RUN) {
        const saiu = await sendDM(client, prev.discordId, farewellPayload({ params }));
        // Marca mesmo se a DM não saiu: uma tentativa por episódio, sem loop.
        await checks.updateOne({ uuid: m.uuid }, { $set: { farewellSentAt: new Date(now) } });
        tentativas += 1;
        if (saiu) {
          avisos += 1;
          await sleep(DM_GAP_MS);
        }
        await audit(
          client,
          guildDiscordId,
          `⏳ **${m.username}** (<@${prev.discordId}>) disse que voltaria e não logou em ${params.inactivityReturnDays} dias. Avisado, e na lista de kick do /verificar.`,
        );
      }
      continue;
    }

    // Estourou o teto da volta: fica para a próxima hora, sem registro — assim
    // ninguém é dado como "não respondeu" a uma pergunta que não foi feita.
    if (tentativas >= MAX_DMS_PER_RUN) continue;

    const discordId = link?.discordId ?? null;
    const deadline = new Date(now + waitMs(params));
    const entregue = discordId
      ? await sendDM(
          client,
          discordId,
          checkInPayload({
            guildName: `${res.guild.name} [${res.guild.prefix}]`,
            uuid: m.uuid,
            deadline,
            r,
            params,
          }),
        )
      : false;

    await checks.replaceOne(
      { uuid: m.uuid },
      {
        uuid: m.uuid,
        username: m.username,
        discordId,
        // Sem vínculo no Discord (ou com a DM fechada) não há como perguntar:
        // o membro vai direto para a lista de kick, com o motivo à mostra.
        status: entregue ? 'pending' : 'unreachable',
        sentAt: new Date(now),
        respondedAt: null,
        offline: r.offline,
        allowance: r.allowance,
        points: r.points,
      },
      { upsert: true },
    );

    if (entregue) {
      tentativas += 1;
      perguntas += 1;
      await sleep(DM_GAP_MS);
    } else {
      semDM += 1;
      if (discordId) tentativas += 1; // a tentativa custou rate limit do mesmo jeito
    }
  }

  // Saiu da guilda: o check-in perdeu o assunto.
  const naGuilda = new Set(res.members.map((m) => m.uuid));
  const orfaos = saved.filter((c) => !naGuilda.has(c.uuid)).map((c) => c.uuid);
  if (orfaos.length) await checks.deleteMany({ uuid: { $in: orfaos } });

  if (tentativas || semDM) {
    log.info(
      `Check-in de inatividade: ${perguntas} pergunta(s), ${avisos} aviso(s) de prazo vencido, ${semDM} sem canal de DM.`,
    );
  }
}

/**
 * Clique num dos dois botões da DM.
 * @param {import('discord.js').ButtonInteraction} interaction
 */
export async function handleInactivityButton(interaction) {
  const [, action, uuid] = interaction.customId.split(':');
  const checks = collections.inactivityChecks();
  const doc = await checks.findOne({ uuid });

  // O registro some quando a pessoa volta a jogar ou sai da guilda — nos dois
  // casos o botão não tem mais o que decidir.
  if (!doc) {
    return interaction.reply({
      content: 'Este aviso não vale mais — ou você já voltou a jogar, ou o assunto foi resolvido pela staff. Nada a fazer. 👍',
      ephemeral: true,
    });
  }
  if (doc.discordId && doc.discordId !== interaction.user.id) {
    return interaction.reply({ content: 'Este aviso não é seu.', ephemeral: true });
  }

  // Trocar de ideia é permitido: quem clicou errado clica no outro botão. O
  // registro guarda sempre a última resposta — e o prazo para logar corre a
  // partir dela, não do primeiro clique.
  const status = action === 'quit' ? 'quit' : 'stay';
  const respondedAt = new Date();
  await checks.updateOne({ uuid }, { $set: { status, respondedAt } });

  const guildDiscordId = optional('DISCORD_GUILD_ID');
  const { params } = await getConfig(guildDiscordId);
  const returnBy = new Date(respondedAt.getTime() + returnMs(params));
  await interaction.update(answeredPayload(status, returnBy));

  const texto = status === 'stay'
    ? `🎮 **${doc.username}** (<@${interaction.user.id}>) respondeu ao check-in: **ainda quer jogar**. Tem até <t:${unix(returnBy)}:f> para logar, ou volta para a lista de kick.`
    : `👋 **${doc.username}** (<@${interaction.user.id}>) respondeu ao check-in: **perdeu o interesse**. Liberar o slot.`;
  await audit(interaction.client, guildDiscordId, texto);
}

/**
 * Divide os membros que já estouraram a margem entre "pode expulsar" e "ainda
 * tem prazo correndo". Função pura: recebe tudo pronto, para o /verificar montar
 * o relatório sem repetir consulta.
 *
 * Dois prazos alimentam a coluna de espera, e os dois terminam em kick se
 * vencerem:
 *   - `pending` → tem `inactivityCheckHours` para clicar num dos botões;
 *   - `stay`    → clicou em "ainda quero jogar" e tem `inactivityReturnDays`
 *                 para LOGAR. Se logasse, `kickable` já seria falso e ele nem
 *                 chegaria aqui — estar nesta lista é a prova de que não logou.
 *
 * Fora da lista, sempre: quem nem foi perguntado ainda (o job pergunta na volta
 * seguinte) e quem voltou a jogar.
 *
 * @param {Array<object>} members       membros vindos de fetchGuildMembers
 * @param {Map<string, number>} pointsByUuid
 * @param {import('../config/guildConfig.js').GuildParams} params
 * @param {Array<object>} checks        documentos de inactivityChecks
 * @param {number} [now]
 * @returns {{kick: Array<object>, waiting: Array<object>}}
 */
export function inactivityStatus(members, pointsByUuid, params, checks, now = Date.now()) {
  const byUuid = new Map(checks.map((c) => [c.uuid, c]));
  const resposta = waitMs(params);
  const volta = returnMs(params);
  const kick = [];
  const waiting = [];

  for (const m of members) {
    const r = evaluate(m, pointsByUuid.get(m.uuid) ?? 0, params);
    if (!r.kickable) continue;

    const c = byUuid.get(m.uuid);
    if (!c) continue;

    const deadline = c.status === 'pending'
      ? new Date(c.sentAt).getTime() + resposta
      : c.status === 'stay'
        ? new Date(c.respondedAt ?? c.sentAt).getTime() + volta
        : null;

    if (deadline !== null && now < deadline) {
      waiting.push({
        username: m.username,
        offline: r.offline,
        deadline,
        // O que a staff está esperando: um clique ou um login.
        note: c.status === 'stay' ? 'precisa logar até' : 'responde até',
      });
      continue;
    }

    kick.push({
      username: m.username,
      offline: r.offline,
      allowance: r.allowance,
      reason: REASON[c.status] ?? c.status,
    });
  }

  kick.sort((a, b) => b.offline - a.offline);
  waiting.sort((a, b) => a.deadline - b.deadline);
  return { kick, waiting };
}
