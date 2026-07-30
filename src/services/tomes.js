import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { ensurePanel } from './panels.js';
import { listAspects } from './aspects.js';
import { daysSince, minGuildDays } from './eligibility.js';
import { brandWithLogo, logoAttachment } from '../util/assets.js';

const STATE_ID = 'tomePanel';
const TOP = 10; // linhas de cada seção no painel ao vivo

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
 * Registra a entrega de um Tome. O crédito consumido é um objetivo semanal:
 * quem ainda tem crédito sobrando CONTINUA na fila (com um tome a menos de
 * direito); quem zerou sai.
 * @returns {Promise<{credits:number, stillQueued:boolean}>}
 */
export async function deliverTome(uuid) {
  await collections.guildStats().updateOne({ uuid }, { $inc: { tomesDelivered: 1 } }, { upsert: true });
  const stat = await collections
    .guildStats()
    .findOne({ uuid }, { projection: { weeklyObjectives: 1, tomesDelivered: 1 } });
  const credits = tomeCredits(stat);
  if (credits <= 0) await collections.tomeQueue().deleteOne({ uuid });
  return { credits, stillQueued: credits > 0 };
}

function fmtAsp(n) {
  return n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

function btn(id, label, emoji, style) {
  return new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);
}

// Painel AO VIVO do canal de tomes/aspects: fila de Tomes (por pontos) + aspects
// gerados em guild raids ainda a entregar. Republicado pelo job de painéis e
// logo após cada ação (entrar/sair da fila, entregar tome/aspect).
export async function buildTomePanel(guildId) {
  const { params } = await getConfig(guildId);
  const minDays = Number(params?.rewardMinGuildDays) || 7;
  const minLvl = Number(params?.tomeMinClassLevel) || 100;
  const { ready: queue, waiting: queueWaiting } = await queueView(guildId);
  const aspects = await listAspects(guildId);
  const pending = aspects.filter((a) => a.eligible && a.pending > 0).sort((a, b) => b.pending - a.pending);
  // Já têm aspect acumulado, mas ainda não completaram os 7 dias de guilda.
  const waiting = aspects.filter((a) => !a.eligible && a.pending > 0).length;

  const queueLines = queue.length
    ? queue
        .slice(0, TOP)
        .map(
          (r, i) =>
            `\`${String(i + 1).padStart(2, ' ')}.\` **${r.username}** — ${r.points} pts · ${r.credits}× 📜`,
        )
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
  const aspectLines = pending
    .slice(0, TOP)
    .map((a) => `**${a.username}** — ${fmtAsp(a.pending)} a entregar · gerou ${fmtAsp(a.earned)} (${a.raids} raids)`);
  if (waiting) aspectLines.push(`-# +${waiting} aguardando completar ${minDays} dias na guilda`);

  const embed = {
    title: '📜 Tomes & ✨ Aspects — Wynn Brasil',
    color: 0x9b59b6,
    description:
      'Entre na **fila de Tomes** (ordenada por pontos de contribuição) e acompanhe os **aspects** que você gerou em guild raids, a serem entregues pela staff.\n' +
      `-# Fila de Tomes: uma classe **nível ${minLvl}** e **1 Tome por missão semanal** cumprida (acumula). Você pode entrar antes, mas só passa a valer na fila com **${minDays} dias** de guilda.`,
    fields: [
      {
        name: `📜 Fila de Tomes (${queue.length})`,
        value: queueLines.join('\n'),
      },
      {
        name: `✨ Aspects a entregar (${pending.length})`,
        value: aspectLines.join('\n') || 'Nada pendente 🎉',
      },
    ],
    footer: { text: 'Fila por pontos · 1 tome por missão semanal · aspects: 0,5 por guild raid' },
    timestamp: new Date().toISOString(),
  };

  return brandWithLogo({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        btn('tome:join', 'Entrar na fila', '📜', ButtonStyle.Success),
        btn('tome:leave', 'Sair da fila', '🚪', ButtonStyle.Danger),
        btn('tome:queue', 'Ver fila', '📋', ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        btn('tome:deliver', 'Entregar Tome', '🎁', ButtonStyle.Primary),
        btn('tome:deliverAspect', 'Entregar Aspect', '✨', ButtonStyle.Primary),
      ),
    ],
  });
}

export async function ensureTomePanel(client, guildId) {
  const cfg = await getConfig(guildId);
  return ensurePanel(client, cfg.channels?.tome, STATE_ID, await buildTomePanel(guildId), 'tomes', [logoAttachment()]);
}
