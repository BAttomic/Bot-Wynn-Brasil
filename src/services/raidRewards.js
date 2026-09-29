import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { optional } from '../config/env.js';
import { ensurePanel } from './panels.js';
import { fetchGuildMembers } from './guildData.js';
import { daysSince, minGuildDays } from './eligibility.js';
import { deliveryLogField, fieldValue } from './rewardLog.js';
import { brandWithLogo, logoAttachment } from '../util/assets.js';
import { log } from '../util/log.js';

// Recompensas de GUILD RAID: aspects e esmeraldas.
//
// O jogo paga a GUILDA por raid, conforme quantos membros nossos estavam no
// grupo, e a guilda repassa em partes IGUAIS a quem participou:
//
//   membros no grupo | a guilda recebe      | cada um fica com
//   1                | 1 aspect + 2.048 Es  | 1     aspect + 2.048    Es
//   2                | 1 aspect + 2.048 Es  | 0,5   aspect + 1.024    Es
//   3                | 2 aspects + 4.096 Es | 0,667 aspect + 1.365,33 Es
//   4                | 2 aspects + 4.096 Es | 0,5   aspect + 1.024    Es
//
// A parte quebrada é SALDO de verdade, não se arredonda: fica acumulando e vira
// unidade entregável quando as próximas raids completarem. O que se entrega é
// sempre inteiro — 1 aspect, ou 1 lote de 1.024 Es, o mínimo de uma operação
// de entrega no jogo.
//
// O crédito é feito NO FIM DE CADA RAID, pelo watcher (ver creditRaidRewards).
// É o único lugar que sabe o tamanho do grupo; o contador `currentGuildRaids`
// da API diz quantas raids a pessoa fez, mas não com quantos. Por isso raid
// feita com o bot fora do ar não rende recompensa — a mesma regra dos eventos.
//
//   gerado   = guildStats.aspectsEarned  / emeraldsEarned   (acumulado, fracionário)
//   entregue = guildStats.aspectsDelivered / emeraldsDelivered
//   saldo    = gerado − entregue     (PODE SER NEGATIVO, de propósito)
//
// O saldo negativo é a correção de erro de digitação embutida na conta. Quem
// recebeu 20 onde eram 2 fica com −18: some da lista de entrega e as próximas
// raids apenas quitam o excedente antes de voltar a gerar. Com `max(0, …)` o
// erro sumia de vista e virava presente permanente.

/** Esmeraldas numa unidade de entrega: 1 entrega = 1.024 Es. */
export const EMERALD_LOT = 1024;

/**
 * Folga para somas de frações. Três raids de três membros dão 3 × 2/3 de
 * aspect, e em ponto flutuante isso pode sair 1,9999999999999998 — o `floor`
 * puro entregaria 1 onde a pessoa tem 2.
 */
const EPS = 1e-6;

/**
 * O que a GUILDA recebe por uma guild raid com `n` membros nossos no grupo: um
 * lote (1 aspect + 2.048 Es) a cada dois membros, arredondando para cima.
 *
 * Grupo maior que 4 não existe no jogo; aparece só se dois grupos terminarem a
 * mesma raid no mesmo mundo e no mesmo minuto (ver detectGuildRaids). A fórmula
 * continua valendo aí, e erra no máximo por um lote.
 *
 * @param {number} n
 * @returns {{aspects:number, emeralds:number}}
 */
export function raidPayout(n) {
  const lotes = Math.ceil(Math.max(0, n) / 2);
  return { aspects: lotes, emeralds: 2 * EMERALD_LOT * lotes };
}

/**
 * Quantas unidades INTEIRAS cabem num saldo. Negativo não vira dívida a entregar.
 * @param {number} saldo  em unidades de entrega
 */
export function wholeUnits(saldo) {
  return Math.max(0, Math.floor(saldo + EPS));
}

const fmtNum = (n, casas = 2) => n.toLocaleString('pt-BR', { maximumFractionDigits: casas });

/**
 * Cada tipo de recompensa de raid. Os valores em `guildStats` ficam na unidade
 * natural (aspects em aspects, esmeraldas em esmeraldas); `unit` converte para a
 * UNIDADE DE ENTREGA, que é o que a staff digita e o que o painel mostra.
 */
export const RAID_REWARD_KINDS = Object.freeze({
  aspect: {
    kind: 'aspect',
    earned: 'aspectsEarned',
    delivered: 'aspectsDelivered',
    unit: 1,
    stateId: 'aspectPanel',
    emoji: '✨',
    title: 'Aspects',
    color: 0x9b59b6,
    /** Unidades de entrega, por extenso. */
    units: (u) => `${fmtNum(u)} aspect(s)`,
    /** O que não fecha uma unidade, na unidade que faz sentido para quem lê. */
    remainder: (u) => `${fmtNum(u)} aspect`,
  },
  emerald: {
    kind: 'emerald',
    earned: 'emeraldsEarned',
    delivered: 'emeraldsDelivered',
    unit: EMERALD_LOT,
    stateId: 'emeraldPanel',
    emoji: '💚',
    title: 'Esmeraldas',
    color: 0x2ecc71,
    units: (u) => `${fmtNum(u)} entrega(s) (${fmtNum(u * EMERALD_LOT)} Es)`,
    remainder: (u) => `${fmtNum(u * EMERALD_LOT)} Es`,
  },
});

/** @param {string} kind */
function kindOf(kind) {
  const k = RAID_REWARD_KINDS[kind];
  if (!k) throw new Error(`Recompensa de raid desconhecida: ${kind}`);
  return k;
}

/**
 * Credita UMA guild raid: cada membro nosso do grupo recebe a sua parte do que a
 * guilda ganhou. Chamado pelo watcher assim que a raid termina.
 *
 * Upsert porque membro recém-chegado pode fechar uma raid antes da primeira
 * apuração criar a linha dele; o `firstSeenAt` é o mesmo que a apuração gravaria.
 *
 * @param {Array<{uuid:string, username:string}>} members  o grupo inteiro
 * @param {Date} [at]
 */
export async function creditRaidRewards(members, at = new Date()) {
  const n = members?.length ?? 0;
  if (!n) return null;
  const { aspects, emeralds } = raidPayout(n);
  for (const { uuid, username } of members) {
    await collections.guildStats().updateOne(
      { uuid },
      {
        $inc: { aspectsEarned: aspects / n, emeraldsEarned: emeralds / n },
        $set: { username },
        $setOnInsert: { firstSeenAt: at },
      },
      { upsert: true },
    );
  }
  log.info(`Guild raid de ${n} membro(s): ${aspects} aspect(s) + ${emeralds} Es divididos.`);
  return { aspects, emeralds, n };
}

const MIGRATION_ID = 'raidRewardsV2';

/**
 * Passa os aspects da regra antiga para o livro-razão novo. Roda UMA vez, no
 * boot, antes de o watcher creditar qualquer raid pela regra nova.
 *
 * A regra antiga não guardava o gerado: derivava de `guildRaids −
 * aspectBaseRaids − aspectSoloRaids`, a 0,5 por raid. Aqui esse número é
 * congelado em `aspectsEarned`, e daí em diante só o watcher o incrementa.
 * O entregue (`aspectsDelivered`) não muda, então o saldo de cada um continua
 * exatamente o que era — inclusive o negativo.
 *
 * O `guildRaids` do banco pode estar até uma hora atrás (a apuração é de hora em
 * hora), e uma raid que ficasse nesse buraco não seria contada por nenhuma das
 * duas regras. Por isso vale o MAIOR entre o banco e a API ao vivo.
 *
 * Esmeraldas começam do zero: não existiam antes.
 *
 * @param {string} guildId  servidor do Discord (para ler a taxa antiga da config)
 */
export async function migrateRaidRewards(guildId) {
  const state = collections.watcherState();
  if (await state.findOne({ _id: MIGRATION_ID })) return null;

  const { params } = await getConfig(guildId);
  // A taxa saiu da config junto com a regra antiga; só o valor gravado no banco
  // (se a staff tinha mudado) ainda pode existir.
  const taxaAntiga = Number(params?.aspectsPerGuildRaid) || 0.5;

  const vivo = new Map();
  const prefix = optional('WYNN_GUILD_PREFIX');
  const res = prefix ? await fetchGuildMembers(prefix).catch(() => null) : null;
  for (const m of res?.members ?? []) vivo.set(m.uuid, m.guildRaids);
  if (!res) log.warn('Migração das recompensas de raid: API fora do ar, usando o guildRaids do banco.');

  const rows = await collections
    .guildStats()
    .find(
      { aspectsEarned: { $exists: false } },
      { projection: { uuid: 1, guildRaids: 1, aspectBaseRaids: 1, aspectSoloRaids: 1 } },
    )
    .toArray();

  const ops = rows.map((r) => {
    const total = Math.max(Number(r.guildRaids) || 0, Number(vivo.get(r.uuid)) || 0);
    const base = r.aspectBaseRaids ?? r.guildRaids ?? 0;
    const raids = Math.max(0, total - base);
    const gerado = Math.max(0, raids - (r.aspectSoloRaids ?? 0)) * taxaAntiga;
    return {
      updateOne: {
        filter: { uuid: r.uuid, aspectsEarned: { $exists: false } },
        update: { $set: { aspectsEarned: gerado } },
      },
    };
  });
  if (ops.length) await collections.guildStats().bulkWrite(ops, { ordered: false });

  await state.insertOne({ _id: MIGRATION_ID, at: new Date(), membros: ops.length, taxaAntiga });
  log.info(`Recompensas de raid: aspects de ${ops.length} membro(s) passados para o livro-razão novo.`);
  return ops.length;
}

/**
 * A conta de um membro só, em UNIDADES DE ENTREGA. Fica isolada para a lista e
 * o resumo de uma pessoa nunca poderem divergir.
 *
 * `pending` é o saldo, fracionário. `deliverable` é quanto dá para entregar DE
 * VERDADE; `remainder` é a fração que sobra acumulando.
 */
function computeReward(r, k, minDays) {
  const earned = (Number(r[k.earned]) || 0) / k.unit;
  const delivered = (Number(r[k.delivered]) || 0) / k.unit;
  const pending = earned - delivered;
  const deliverable = wholeUnits(pending);
  const resto = pending - deliverable;
  const days = daysSince(r.joinedGuildAt);
  return {
    uuid: r.uuid,
    username: r.username,
    earned,
    delivered,
    pending,
    deliverable,
    remainder: resto > EPS ? resto : 0,
    days,
    eligible: days !== null && days >= minDays,
  };
}

function projection(k) {
  return { uuid: 1, username: 1, joinedGuildAt: 1, [k.earned]: 1, [k.delivered]: 1 };
}

/**
 * Todo mundo que já gerou ou recebeu esta recompensa, com a elegibilidade dos
 * dias de guilda (só elegíveis RECEBEM; os demais acumulam e esperam).
 * @param {string} guildId
 * @param {'aspect'|'emerald'} kind
 */
export async function listRewards(guildId, kind) {
  const k = kindOf(kind);
  const minDays = await minGuildDays(guildId);
  const rows = await collections
    .guildStats()
    .find({ $or: [{ [k.earned]: { $gt: 0 } }, { [k.delivered]: { $gt: 0 } }] }, { projection: projection(k) })
    .toArray();
  return rows.map((r) => computeReward(r, k, minDays));
}

/**
 * O mesmo retrato, para UMA pessoa.
 * @returns {Promise<ReturnType<typeof computeReward>|null>}
 */
export async function rewardStatus(guildId, kind, uuid) {
  const k = kindOf(kind);
  const row = await collections.guildStats().findOne({ uuid }, { projection: projection(k) });
  return row ? computeReward(row, k, await minGuildDays(guildId)) : null;
}

/**
 * Só quem PODE receber agora: elegível e com pelo menos UMA unidade inteira.
 * Quem tem só fração fica de fora — listar essa pessoa no menu seria oferecer
 * uma entrega impossível.
 */
export async function pendingRewards(guildId, kind) {
  return (await listRewards(guildId, kind))
    .filter((a) => a.eligible && a.deliverable >= 1)
    .sort((a, b) => b.deliverable - a.deliverable || b.pending - a.pending);
}

/**
 * Registra uma entrega, em unidades de entrega.
 *
 * Entregar MAIS do que o saldo é permitido de propósito — acontece de a staff
 * passar a mais no jogo, e o excedente vira saldo negativo que as próximas raids
 * quitam.
 *
 * @returns {Promise<boolean>} false se a quantidade não for um inteiro positivo
 */
export async function deliverRewards(kind, uuid, units) {
  const k = kindOf(kind);
  if (!Number.isInteger(units) || units <= 0) return false;
  await collections.guildStats().updateOne({ uuid }, { $inc: { [k.delivered]: units * k.unit } });
  return true;
}

/**
 * Soma ou estorna unidades sobre o total já entregue — "passei 18 a mais" vira
 * `-18`, sem precisar saber o acumulado. O total nunca fica negativo: entregue é
 * "quanto saiu do baú". Quem fica negativo é o SALDO.
 *
 * Pipeline para ler e escrever numa operação só: duas correções simultâneas não
 * podem se sobrescrever.
 *
 * @returns {Promise<{antes:number, agora:number}|null>} em unidades; null se não achou
 */
export async function adjustRewardsDelivered(kind, uuid, delta) {
  const k = kindOf(kind);
  if (!Number.isInteger(delta) || delta === 0) return null;
  const antes = await collections.guildStats().findOneAndUpdate(
    { uuid },
    [{ $set: { [k.delivered]: { $max: [0, { $add: [{ $ifNull: [`$${k.delivered}`, 0] }, delta * k.unit] }] } } }],
    { returnDocument: 'before', projection: { [k.delivered]: 1 } },
  );
  if (!antes) return null;
  const valorAntes = (antes[k.delivered] ?? 0) / k.unit;
  return { antes: valorAntes, agora: Math.max(0, valorAntes + delta) };
}

/**
 * Reescreve o total já entregue, para quando se sabe o número certo. É um SET
 * de propósito: "entreguei 2, não 20" é direto; "subtraia 18" exige fazer a
 * conta de cabeça e erra de novo.
 *
 * @returns {Promise<{antes:number, agora:number}|null>} em unidades; null se não achou
 */
export async function setRewardsDelivered(kind, uuid, total) {
  const k = kindOf(kind);
  if (!Number.isInteger(total) || total < 0) return null;
  const antes = await collections
    .guildStats()
    .findOneAndUpdate(
      { uuid },
      { $set: { [k.delivered]: total * k.unit } },
      { returnDocument: 'before', projection: { [k.delivered]: 1 } },
    );
  if (!antes) return null;
  return { antes: (antes[k.delivered] ?? 0) / k.unit, agora: total };
}

/**
 * A tabela de regras do painel, montada de `raidPayout`: o texto não pode
 * divergir da conta que o bot faz.
 */
function rulesTable(k) {
  return [1, 2, 3, 4].map((n) => {
    const p = raidPayout(n);
    const guilda = k.kind === 'aspect' ? `${p.aspects} ${p.aspects === 1 ? 'aspect' : 'aspects'}` : `${fmtNum(p.emeralds)} Es`;
    const cada = k.kind === 'aspect' ? `${fmtNum(p.aspects / n)} aspect` : `${fmtNum(p.emeralds / n)} Es`;
    return `> **${n}** ${n === 1 ? 'membro' : 'membros'} → a guilda recebe ${guilda} · **${cada}** ${n === 1 ? 'para ele' : 'para cada'}`;
  });
}

function rulesText(k, minDays) {
  const entrega =
    k.kind === 'aspect'
      ? 'A staff entrega em **unidades inteiras** (mínimo **1 aspect**).'
      : `A staff entrega em **lotes de ${fmtNum(EMERALD_LOT)} Es** — **1 entrega = ${fmtNum(EMERALD_LOT)} Es**, o mínimo por operação.`;
  return [
    `Toda **guild raid** rende ${k.kind === 'aspect' ? 'aspects' : 'esmeraldas'} à guilda conforme quantos membros **nossos** estavam no grupo, e o total é **dividido igualmente** entre eles:`,
    ...rulesTable(k),
    `${entrega} A parte quebrada fica no seu saldo e soma com as próximas raids — nada se perde.`,
    `-# Recebe quem tem **${minDays} dias** de guilda; antes disso o saldo acumula e espera. Não precisa pedir: a lista abaixo é a fila de entrega.`,
  ].join('\n');
}

/** Painel AO VIVO de uma recompensa de raid: regras, quem tem a receber e o log. */
export async function buildRaidRewardPanel(guildId, kind) {
  const k = kindOf(kind);
  const minDays = await minGuildDays(guildId);
  const all = await listRewards(guildId, kind);
  const pending = all
    .filter((a) => a.eligible && a.deliverable >= 1)
    .sort((a, b) => b.deliverable - a.deliverable || b.pending - a.pending);
  // Já têm unidade inteira acumulada, mas ainda não completaram os dias de guilda.
  const waiting = all.filter((a) => !a.eligible && a.deliverable >= 1).length;

  // Só o que a staff precisa fazer: quantas unidades INTEIRAS entregar. A fração
  // que sobra fica no saldo e não é acionável agora.
  const linhas = pending.map(
    (a) =>
      `**${a.username}** — **${k.units(a.deliverable)}**` +
      (a.remainder ? ` · +${k.remainder(a.remainder)} acumulando` : ''),
  );
  if (waiting) linhas.push(`-# +${waiting} aguardando completar ${minDays} dias na guilda`);
  const total = pending.reduce((s, a) => s + a.deliverable, 0);

  const embed = {
    title: `${k.emoji} ${k.title} — Guild Raids`,
    color: k.color,
    description: rulesText(k, minDays),
    fields: [
      {
        name: `${k.emoji} A entregar — ${pending.length} pessoa(s)${total ? ` · ${k.units(total)}` : ''}`,
        value: fieldValue(linhas) || 'Nada pendente 🎉',
      },
      await deliveryLogField(kind, (d) => `${k.emoji} ${k.units(d.amount)}`),
    ],
    footer: { text: 'Creditado no fim de cada guild raid · horário de Brasília' },
    timestamp: new Date().toISOString(),
  };

  return brandWithLogo({
    embeds: [embed],
    // Sem menções: o log é um extrato, não um aviso. Os <@id> continuam
    // clicáveis, mas ninguém é notificado a cada entrega.
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`raid:${kind}:deliver`)
          .setLabel(`Entregar ${k.title}`)
          .setEmoji(k.emoji)
          .setStyle(ButtonStyle.Primary),
      ),
    ],
  });
}

export async function ensureRaidRewardPanel(client, guildId, kind) {
  const k = kindOf(kind);
  const cfg = await getConfig(guildId);
  return ensurePanel(
    client,
    cfg.channels?.tome,
    k.stateId,
    await buildRaidRewardPanel(guildId, kind),
    k.title.toLowerCase(),
    [logoAttachment()],
  );
}

/**
 * O antigo painel de histórico (`tomeLogPanel`, logo abaixo da fila de Tomes)
 * vira o painel de Aspects. Reaproveitar a mensagem mantém a ordem do canal —
 * Tomes, Aspects, Esmeraldas — sem apagar nem reenviar nada: o de Esmeraldas,
 * que é novo, nasce embaixo dos dois. Roda no boot; no-op depois da primeira vez.
 */
export async function adoptLegacyLogPanel() {
  const state = collections.watcherState();
  if (await state.findOne({ _id: RAID_REWARD_KINDS.aspect.stateId })) return;
  const antigo = await state.findOne({ _id: 'tomeLogPanel' });
  if (!antigo?.messageId) return;
  await state.insertOne({
    _id: RAID_REWARD_KINDS.aspect.stateId,
    messageId: antigo.messageId,
    channelId: antigo.channelId,
  });
  await state.deleteOne({ _id: 'tomeLogPanel' });
  log.info('Painel de histórico de entregas virou o painel de Aspects.');
}
