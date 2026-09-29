import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { RAID_REWARD_KINDS } from './raidRewards.js';
import { deliveryLogField, fieldValue } from './rewardLog.js';
import { daysSince, minGuildDays } from './eligibility.js';
import { brandWithLogo, logoAttachment } from '../util/assets.js';

const STATE_ID = 'tomePanel';
const TOP = 10; // pessoas mostradas na fila do painel

/**
 * Quantos Tomes a pessoa ainda tem DIREITO a receber: cada objetivo semanal da
 * guilda que ela cumpriu vale um Tome, menos os que já recebeu. Acumula — quem
 * tem 2 semanais e nunca pegou tome pode pegar 2.
 *
 * `weeklyObjectives` é derivado do livro-razão (só conta do dia em que o bot
 * começou a acompanhar); `tomesDelivered` é o acumulado de entregas.
 * @param {{weeklyObjectives?:number, tomesDelivered?:number}} [stat]
 * @returns {number}
 */
export function tomeCredits(stat) {
  return Math.max(0, (stat?.weeklyObjectives ?? 0) - (stat?.tomesDelivered ?? 0));
}

// A prioridade da fila de Tomes usa o sistema de pontos unificado (design.md §17):
// quem tem mais pontos (guerras + raids + contribuição + eventos) vem primeiro.
//
// Como nos aspects, os 7 dias de guilda NÃO barram a entrada: qualquer registrado
// (com a classe no nível mínimo) pode entrar na fila e ficar acumulando pontos,
// mas só ENTRA NA FILA DE VERDADE — aparecendo no painel e podendo receber — depois
// de completar os dias E de ter crédito de missão semanal. Os demais ficam em espera.
export async function rankedQueue(guildId) {
  const queue = await collections.tomeQueue().find({}).toArray();
  if (!queue.length) return [];
  const minDays = await minGuildDays(guildId);
  const uuids = queue.map((q) => q.uuid);
  const stats = await collections
    .guildStats()
    .find(
      { uuid: { $in: uuids } },
      { projection: { uuid: 1, points: 1, joinedGuildAt: 1, weeklyObjectives: 1, tomesDelivered: 1 } },
    )
    .toArray();
  const byUuid = new Map(stats.map((s) => [s.uuid, s]));
  return queue
    // Quem recebeu além do direito está barrado da fila (ver joinQueue). A
    // correção já o tira, mas quem estava na fila antes disso não pode seguir
    // aparecendo nela.
    .filter((q) => {
      const s = byUuid.get(q.uuid);
      return (s?.tomesDelivered ?? 0) <= (s?.weeklyObjectives ?? 0);
    })
    .map((q) => {
      const s = byUuid.get(q.uuid);
      const days = daysSince(s?.joinedGuildAt);
      const tenureOk = days !== null && days >= minDays;
      const credits = tomeCredits(s);
      return {
        ...q,
        points: s?.points ?? 0,
        days,
        tenureOk,
        credits,
        // "X de Y" na fila: Y é o direito de VIDA (uma missão semanal cumprida =
        // um Tome, acumulando), X é quanto já saiu. Mostrar o SALDO no lugar de Y
        // confundia — "recebeu 3 · pode receber 2" se lê como cota estourada,
        // quando na verdade a pessoa cumpriu 5 semanais e levou 3.
        delivered: s?.tomesDelivered ?? 0,
        entitled: s?.weeklyObjectives ?? 0,
        ready: tenureOk && credits > 0,
        // Por que está em espera — o primeiro motivo que falta.
        blockedBy: !tenureOk ? 'days' : credits <= 0 ? 'weekly' : null,
      };
    })
    .sort((a, b) => b.points - a.points);
}

/**
 * A fila separada em quem já pode receber (`ready`) e quem entrou mas ainda
 * espera (dias de guilda ou missão semanal). Ambas ordenadas por pontos.
 * @returns {Promise<{ready:Array<object>, waiting:Array<object>, minDays:number}>}
 */
export async function queueView(guildId) {
  const all = await rankedQueue(guildId);
  return {
    ready: all.filter((r) => r.ready),
    waiting: all.filter((r) => !r.ready),
    minDays: await minGuildDays(guildId),
  };
}

/**
 * Registra a entrega de um Tome e TIRA a pessoa da fila, sempre. Ter direito a
 * outro não a mantém na fila: quem quiser o próximo entra de novo, e volta para
 * o fim — ou melhor, para a posição que os pontos dela mandarem.
 *
 * @returns {Promise<{credits:number, delivered:number, entitled:number}>}
 *   `credits` = quantos ainda pode pedir; `delivered` = total que já recebeu,
 *   esta entrega inclusa; `entitled` = direito de vida (semanais cumpridas)
 */
export async function deliverTome(uuid) {
  await collections.guildStats().updateOne({ uuid }, { $inc: { tomesDelivered: 1 } }, { upsert: true });
  await collections.tomeQueue().deleteOne({ uuid });
  const stat = await collections
    .guildStats()
    .findOne({ uuid }, { projection: { weeklyObjectives: 1, tomesDelivered: 1 } });
  return {
    credits: tomeCredits(stat),
    delivered: stat?.tomesDelivered ?? 0,
    entitled: stat?.weeklyObjectives ?? 0,
  };
}

/**
 * Soma (ou tira) Tomes do total já entregue, sem precisar saber o acumulado.
 *
 * É o mesmo `ajustar` do /aspects: "entreguei 5 a mais e não registrei" vira
 * `+5`, "registrei 2 que não saíram" vira `-2`. Não mexe na fila — quem ficar
 * sem crédito continua nela, só que em espera.
 *
 * Passar do direito é permitido de propósito: `tomeCredits` só zera o que se
 * MOSTRA, o excedente fica guardado em `tomesDelivered`, e as próximas missões
 * semanais quitam a diferença antes de voltar a dar direito a Tome.
 *
 * O total nunca fica negativo: entregue é "quanto saiu do baú".
 *
 * @param {string} uuid
 * @param {number} delta  inteiro; positivo soma, negativo estorna
 * @returns {Promise<{antes:number, agora:number}|null>} null se delta inválido
 */
export async function adjustTomesDelivered(uuid, delta) {
  if (!Number.isInteger(delta) || delta === 0) return null;
  // Pipeline para ler e escrever numa operação só: duas correções simultâneas
  // não podem se sobrescrever.
  const antes = await collections.guildStats().findOneAndUpdate(
    { uuid },
    [{ $set: { tomesDelivered: { $max: [0, { $add: [{ $ifNull: ['$tomesDelivered', 0] }, delta] }] } } }],
    { upsert: true, returnDocument: 'before', projection: { tomesDelivered: 1 } },
  );
  const valorAntes = antes?.tomesDelivered ?? 0;
  return { antes: valorAntes, agora: Math.max(0, valorAntes + delta) };
}

/**
 * Reescreve o total já entregue, para quando se sabe o número certo.
 * @param {string} uuid
 * @param {number} total  inteiro >= 0
 * @returns {Promise<{antes:number, agora:number}|null>} null se total inválido
 */
export async function setTomesDelivered(uuid, total) {
  if (!Number.isInteger(total) || total < 0) return null;
  const antes = await collections
    .guildStats()
    .findOneAndUpdate(
      { uuid },
      { $set: { tomesDelivered: total } },
      { upsert: true, returnDocument: 'before', projection: { tomesDelivered: 1 } },
    );
  return { antes: antes?.tomesDelivered ?? 0, agora: total };
}

/**
 * O retrato de Tomes de UMA pessoa: direito de vida, quanto já saiu, quanto
 * ainda pode pedir e quanto recebeu além do direito.
 * @returns {Promise<{delivered:number, entitled:number, credits:number, excess:number}>}
 */
export async function tomeStatus(uuid) {
  const stat = await collections
    .guildStats()
    .findOne({ uuid }, { projection: { weeklyObjectives: 1, tomesDelivered: 1 } });
  const delivered = stat?.tomesDelivered ?? 0;
  const entitled = stat?.weeklyObjectives ?? 0;
  return { delivered, entitled, credits: tomeCredits(stat), excess: Math.max(0, delivered - entitled) };
}

function btn(id, label, emoji, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

// Painel AO VIVO de Tomes: regras, fila (por pontos) e as últimas entregas.
// Republicado pelo job de painéis e logo após cada ação (entrar/sair da fila,
// entregar). Aspects e esmeraldas têm painel próprio (services/raidRewards.js).
export async function buildTomePanel(guildId) {
  const { params } = await getConfig(guildId);
  const minDays = Number(params?.rewardMinGuildDays) || 7;
  const minLvl = Number(params?.tomeMinClassLevel) || 100;
  const { ready: queue, waiting: queueWaiting } = await queueView(guildId);

  // Duas linhas por pessoa: a posição e, logo abaixo, o acumulado de vida. Quem
  // olha a fila quer saber "quanto essa pessoa já levou?" antes de entregar, e
  // esse número não estava em lugar nenhum — só aparecia depois da entrega.
  const queueLines = queue.length
    ? queue
        .slice(0, TOP)
        .flatMap((r, i) => [
          `\`${String(i + 1).padStart(2, ' ')}.\` **${r.username}** — ${r.points} pts`,
          `> já recebeu **${r.delivered}** de **${r.entitled}** 📜 a que tem direito`,
        ])
    : ['Fila vazia — clique em **Entrar na fila**.'];
  // Entraram na fila, mas ainda faltam dias de guilda ou missão semanal.
  if (queueWaiting.length) {
    const byDays = queueWaiting.filter((r) => r.blockedBy === 'days').length;
    const byWeekly = queueWaiting.length - byDays;
    const motivos = [byDays && `${byDays} sem os ${minDays} dias`, byWeekly && `${byWeekly} sem missão semanal`]
      .filter(Boolean)
      .join(' · ');
    queueLines.push(`-# +${queueWaiting.length} em espera (${motivos})`);
  }

  const embed = {
    title: '📜 Tomes — Objetivo Semanal',
    color: 0x9b59b6,
    description: [
      'Os Tomes nascem do **objetivo semanal** da guilda e saem por fila — não precisa pedir.',
      '> **1 Tome por objetivo semanal** que você cumprir. Acumula: 3 semanais = direito a 3 Tomes.',
      '> A fila é por **pontos de contribuição**: quem mais contribuiu recebe primeiro.',
      `> Requisitos do jogo: uma classe **nível ${minLvl}** e **${minDays} dias** de guilda. Dá para entrar antes; você só aparece na fila quando cumprir os dois.`,
      '> A fila vale por **1 Tome**: recebeu, sai. Tem direito a mais? Entre de novo, sem espera.',
    ].join('\n'),
    fields: [
      {
        name: `📜 Fila de Tomes (${queue.length})`,
        // Duas linhas por pessoa aproximam o teto de 1024 do Discord; cortar é
        // melhor que o painel inteiro falhar ao editar.
        value: fieldValue(queueLines),
      },
      await deliveryLogField('tome', () => '📜 Tome'),
    ],
    footer: { text: 'Fila por pontos · 1 Tome por objetivo semanal · horário de Brasília' },
    timestamp: new Date().toISOString(),
  };

  return brandWithLogo({
    embeds: [embed],
    // Sem menções: o log é um extrato, não um aviso.
    allowedMentions: { parse: [] },
    // Sem "Ver fila": a fila já está no embed acima, e o botão só gerava uma
    // cópia efêmera dela para quem clicasse.
    components: [
      new ActionRowBuilder().addComponents(
        btn('tome:join', 'Entrar na fila', '📜', ButtonStyle.Success),
        btn('tome:leave', 'Sair da fila', '🚪', ButtonStyle.Danger),
        btn('tome:deliver', 'Entregar Tome', '🎁', ButtonStyle.Primary),
      ),
    ],
  });
}

export async function ensureTomePanel(client, guildId) {
  const cfg = await getConfig(guildId);
  return ensurePanel(client, cfg.channels?.tome, STATE_ID, await buildTomePanel(guildId), 'tomes', [logoAttachment()]);
}

/**
 * Os painéis fixos do canal de recompensas — a limpeza não pode apagá-los. O
 * `tomeLogPanel` fica na lista até o boot adotá-lo como painel de Aspects
 * (ver adoptLegacyLogPanel).
 */
export const REWARD_PANEL_STATE_IDS = Object.freeze([
  STATE_ID,
  ...Object.values(RAID_REWARD_KINDS).map((k) => k.stateId),
  'tomeLogPanel',
]);
