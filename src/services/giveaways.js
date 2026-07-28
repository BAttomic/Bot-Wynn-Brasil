import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { slugify } from './events.js';
import { log } from '../util/log.js';

// Sorteios (giveaways).
//
// A inscrição é um botão na própria mensagem do sorteio, e cada clique alterna
// entrar/sair. Quem garante "uma inscrição por pessoa" é o índice único
// (giveawayId, discordId) — não a checagem em memória, que corre risco de clique
// duplo. O sorteio em si só acontece uma vez: o `status` vira 'ended' na mesma
// operação que grava os vencedores.

const HOUR_MS = 3_600_000;

/** Requisitos de participação aceitos. */
export const REQUIREMENTS = Object.freeze({
  nenhum: { label: 'Aberto a todos' },
  vinculado: { label: 'Conta vinculada (/link)' },
  guilda: { label: 'Membro da guilda' },
  pontos: { label: 'Pontos mínimos' },
});

const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

async function uniqueGiveawayId(base) {
  const gws = collections.giveaways();
  let id = base;
  for (let n = 2; await gws.findOne({ giveawayId: id }); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * @param {object} args
 * @param {string} args.prize
 * @param {number} args.hours          duração em horas
 * @param {number} [args.winnersCount]
 * @param {string} [args.requirement]  chave de REQUIREMENTS
 * @param {number} [args.minPoints]    usado quando requirement = 'pontos'
 * @param {string} args.guildDiscordId
 * @param {string} args.createdBy
 * @param {string} args.channelId
 */
export async function createGiveaway({
  prize,
  hours,
  winnersCount = 1,
  requirement = 'nenhum',
  minPoints = 0,
  guildDiscordId,
  createdBy,
  channelId,
}) {
  const now = new Date();
  const doc = {
    giveawayId: await uniqueGiveawayId(slugify(prize)),
    prize: prize.trim(),
    winnersCount: Math.max(1, Math.min(20, winnersCount)),
    requirement: REQUIREMENTS[requirement] ? requirement : 'nenhum',
    minPoints: Math.max(0, minPoints),
    startAt: now,
    endAt: new Date(now.getTime() + hours * HOUR_MS),
    status: 'active',
    guildDiscordId,
    createdBy,
    channelId,
    messageId: null,
    winners: [],
    createdAt: now,
  };
  await collections.giveaways().insertOne(doc);
  return doc;
}

export function getGiveaway(giveawayId) {
  return collections.giveaways().findOne({ giveawayId });
}

export function listGiveaways(limit = 15) {
  return collections.giveaways().find({}).sort({ startAt: -1 }).limit(limit).toArray();
}

export function entryCount(giveawayId) {
  return collections.giveawayEntries().countDocuments({ giveawayId });
}

/**
 * Verifica se a pessoa pode participar, segundo o requisito do sorteio.
 * @returns {Promise<{ok: boolean, reason?: string, uuid?: string, username?: string}>}
 */
export async function checkEligibility(giveaway, discordId) {
  if (giveaway.requirement === 'nenhum') return { ok: true };

  const member = await collections.members().findOne({ discordId });
  if (!member) return { ok: false, reason: 'Este sorteio exige conta vinculada. Use `/link <nick>`.' };

  const info = { uuid: member.uuid, username: member.username };
  if (giveaway.requirement === 'vinculado') return { ok: true, ...info };

  if (giveaway.requirement === 'guilda' && !member.inGuild) {
    return { ok: false, reason: 'Este sorteio é só para membros da guilda.' };
  }
  if (giveaway.requirement === 'pontos') {
    const stats = await collections.guildStats().findOne({ uuid: member.uuid }, { projection: { points: 1 } });
    const pts = stats?.points ?? 0;
    if (pts < giveaway.minPoints) {
      return { ok: false, reason: `Este sorteio exige **${giveaway.minPoints}** pontos — você tem **${pts}**.` };
    }
  }
  return { ok: true, ...info };
}

/**
 * Alterna a participação: quem não está, entra; quem está, sai.
 * @returns {Promise<{status: 'joined'|'left'|'closed'|'blocked', reason?: string, total: number}>}
 */
export async function toggleEntry(giveaway, discordId) {
  const entries = collections.giveawayEntries();

  if (giveaway.status !== 'active' || new Date(giveaway.endAt) <= new Date()) {
    return { status: 'closed', total: await entryCount(giveaway.giveawayId) };
  }

  const existing = await entries.findOne({ giveawayId: giveaway.giveawayId, discordId });
  if (existing) {
    await entries.deleteOne({ _id: existing._id });
    return { status: 'left', total: await entryCount(giveaway.giveawayId) };
  }

  const elig = await checkEligibility(giveaway, discordId);
  if (!elig.ok) {
    return { status: 'blocked', reason: elig.reason, total: await entryCount(giveaway.giveawayId) };
  }

  try {
    await entries.insertOne({
      giveawayId: giveaway.giveawayId,
      discordId,
      uuid: elig.uuid ?? null,
      username: elig.username ?? null,
      joinedAt: new Date(),
    });
  } catch (e) {
    // Clique duplo bate no índice único: a inscrição já existe, então está feito.
    if (e?.code !== 11000) throw e;
  }
  return { status: 'joined', total: await entryCount(giveaway.giveawayId) };
}

/** Botão de participação. O id do sorteio viaja no customId. */
export function joinRow(giveawayId, disabled = false) {
  return {
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: 'Participar',
        emoji: { name: '🎉' },
        custom_id: `gw:join:${giveawayId}`,
        disabled,
      },
    ],
  };
}

/** @param {object} giveaway @param {number} total participantes */
export function renderGiveaway(giveaway, total) {
  const encerrado = giveaway.status !== 'active';
  const req = REQUIREMENTS[giveaway.requirement]?.label ?? 'Aberto a todos';
  const requisito =
    giveaway.requirement === 'pontos' ? `${req}: **${giveaway.minPoints}** pts` : req;

  const vencedores = giveaway.winners?.length
    ? giveaway.winners.map((w) => `🎉 <@${w.discordId}>`).join(', ')
    : null;

  return {
    title: `🎁 Sorteio — ${giveaway.prize}`,
    description: encerrado
      ? vencedores
        ? `**Encerrado!** Vencedor(es): ${vencedores}`
        : '**Encerrado** — ninguém participou.'
      : 'Clique em **Participar** para entrar. Clique de novo para sair.',
    color: encerrado ? 0x95a5a6 : 0x9b59b6,
    fields: [
      {
        name: '⏳ Sorteio',
        value: encerrado ? `<t:${unix(giveaway.endAt)}:f>` : `<t:${unix(giveaway.endAt)}:R> (<t:${unix(giveaway.endAt)}:f>)`,
        inline: true,
      },
      { name: '🏆 Vagas', value: String(giveaway.winnersCount), inline: true },
      { name: '👥 Participantes', value: String(total), inline: true },
      { name: '📋 Requisito', value: requisito, inline: false },
    ],
    footer: { text: `Sorteio \`${giveaway.giveawayId}\`` },
    timestamp: new Date().toISOString(),
  };
}

async function giveawayChannel(client, giveaway) {
  const cfg = await getConfig(giveaway.guildDiscordId);
  const ids = [giveaway.channelId, cfg.channels?.events, cfg.channels?.panel].filter(Boolean);
  for (const id of ids) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) return ch;
  }
  return null;
}

/** Publica ou reedita a mensagem do sorteio. */
export async function ensureGiveawayMessage(client, giveaway) {
  const channel = await giveawayChannel(client, giveaway);
  if (!channel) return null;

  const total = await entryCount(giveaway.giveawayId);
  const encerrado = giveaway.status !== 'active';
  const payload = {
    embeds: [renderGiveaway(giveaway, total)],
    components: encerrado ? [] : [joinRow(giveaway.giveawayId)],
  };

  if (giveaway.messageId) {
    const msg = await channel.messages.fetch(giveaway.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      return msg;
    }
  }
  const msg = await channel.send(payload).catch(() => null);
  if (msg) {
    await collections
      .giveaways()
      .updateOne({ giveawayId: giveaway.giveawayId }, { $set: { messageId: msg.id, channelId: channel.id } });
  }
  return msg;
}

/**
 * Sorteia `count` inscritos distintos (Fisher-Yates parcial).
 * @param {Array<object>} entries
 * @param {number} count
 */
function drawFrom(entries, count) {
  const pool = [...entries];
  const picked = [];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
    picked.push(pool[i]);
  }
  return picked;
}

/**
 * Encerra e sorteia. Idempotente: um sorteio já encerrado devolve os vencedores
 * que já tinha, sem sortear de novo.
 * @param {import('discord.js').Client} client
 * @param {object} giveaway
 * @returns {Promise<{winners: Array<object>}>}
 */
export async function endGiveaway(client, giveaway) {
  if (giveaway.status !== 'active') return { winners: giveaway.winners ?? [] };

  const now = new Date();
  // Fecha ANTES de sortear: se o job e um /giveaway encerrar correrem juntos,
  // só um dos dois encontra o sorteio ativo.
  const res = await collections
    .giveaways()
    .findOneAndUpdate(
      { giveawayId: giveaway.giveawayId, status: 'active' },
      { $set: { status: 'ended', closedAt: now } },
    );
  if (!res) return { winners: [] };

  const entries = await collections.giveawayEntries().find({ giveawayId: giveaway.giveawayId }).toArray();
  const winners = drawFrom(entries, giveaway.winnersCount).map((e) => ({
    discordId: e.discordId,
    uuid: e.uuid,
    username: e.username,
  }));

  await collections.giveaways().updateOne({ giveawayId: giveaway.giveawayId }, { $set: { winners } });

  const closed = { ...giveaway, status: 'ended', winners, closedAt: now };
  await ensureGiveawayMessage(client, closed);
  await announceWinners(client, closed, entries.length);

  log.info(`Sorteio ${giveaway.giveawayId} encerrado (${entries.length} inscritos, ${winners.length} vencedor(es)).`);
  return { winners };
}

/**
 * Sorteia de novo, excluindo quem já ganhou (ex.: vencedor sumiu).
 * @returns {Promise<{winners: Array<object>}|null>} null se o sorteio não terminou
 */
export async function rerollGiveaway(client, giveaway) {
  if (giveaway.status !== 'ended') return null;

  const anteriores = new Set((giveaway.winners ?? []).map((w) => w.discordId));
  const entries = await collections
    .giveawayEntries()
    .find({ giveawayId: giveaway.giveawayId, discordId: { $nin: [...anteriores] } })
    .toArray();

  const winners = drawFrom(entries, giveaway.winnersCount).map((e) => ({
    discordId: e.discordId,
    uuid: e.uuid,
    username: e.username,
  }));
  await collections
    .giveaways()
    .updateOne({ giveawayId: giveaway.giveawayId }, { $set: { winners, rerolledAt: new Date() } });

  const updated = { ...giveaway, winners };
  await ensureGiveawayMessage(client, updated);
  await announceWinners(client, updated, entries.length, true);
  return { winners };
}

async function announceWinners(client, giveaway, total, reroll = false) {
  const channel = await giveawayChannel(client, giveaway);
  if (!channel) return;

  const conteudo = giveaway.winners.length
    ? `${reroll ? '🔁 **Novo sorteio!**' : '🎉 **Sorteio encerrado!**'}\n` +
      `Prêmio: **${giveaway.prize}**\n` +
      `Vencedor(es): ${giveaway.winners.map((w) => `<@${w.discordId}>`).join(', ')}\n` +
      `-# ${total} participante(s). Falem com a staff para receber.`
    : `😢 O sorteio de **${giveaway.prize}** terminou sem participantes${reroll ? ' elegíveis para o re-sorteio' : ''}.`;

  await channel
    .send({
      content: conteudo,
      allowedMentions: { users: giveaway.winners.map((w) => w.discordId) },
    })
    .catch(() => {});
}
