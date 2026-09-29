import { randomUUID } from 'node:crypto';
import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';

// Advertências.
//
// Ao contrário do ban — um registro por pessoa, que só cresce — cada warn é uma
// LINHA própria. Precisa ser: o histórico é o produto aqui, e uma advertência
// perdoada não pode sumir do registro.
//
// A identidade é indexada pelos dois lados, como em bans.js: quem adverte um
// Discord acerta a pessoa mesmo que ela troque de conta do Minecraft, e vice-
// versa. A diferença é que warn TOLERA uuid ausente — dá para advertir alguém
// que nunca se registrou.
//
// Warn NÃO bane. Já baniu, ao chegar em `warnsToBan` ativas, e foi assim que um
// Chefe acabou banido sem ninguém da staff ter decidido isso. Ban é sempre uma
// decisão de um Chefe (Staff), pelo /ban.
//
// A validade NÃO é congelada na criação. Igual ao livro-razão de pontos, o que
// se guarda é o fato cru (quando aconteceu) e a regra é aplicada na hora de ler.
// Baixar `warnExpiryDays` de 90 para 30 encolhe todo o histórico de uma vez, em
// vez de valer só para os warns futuros — que seria uma regra invisível,
// diferente para cada linha, impossível de explicar a quem foi advertido.

/** Id curto e sorteável, para caber num `/warn remove id:`. */
function newWarnId() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

async function params(guildDiscordId) {
  return (await getConfig(guildDiscordId)).params || {};
}

/**
 * Instante antes do qual um warn deixou de contar.
 * @param {number} days  0 ou negativo = advertências nunca expiram
 */
export function expiryCutoff(days, now = new Date()) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return null;
  return new Date(now.getTime() - d * 86_400_000);
}

/** Casa por qualquer um dos dois lados da identidade. @returns {object|null} */
function identityFilter({ uuid = null, discordId = null }) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordId });
  return or.length ? { $or: or } : null;
}

/**
 * Histórico completo, do mais recente para o mais antigo — inclusive os
 * expirados e os perdoados, cada um marcado.
 * @returns {Promise<Array<object & {expired: boolean, active: boolean}>>}
 */
export async function warnHistory(guildDiscordId, ids, limit = 25) {
  const id = identityFilter(ids);
  if (!id) return [];
  const cutoff = expiryCutoff((await params(guildDiscordId)).warnExpiryDays);
  const docs = await collections.warns().find(id).sort({ at: -1 }).limit(limit).toArray();
  return docs.map((w) => {
    const expired = !!cutoff && w.at < cutoff;
    return { ...w, expired, active: !w.removed && !expired };
  });
}

/** Só as que ainda contam para o ban automático. */
export async function activeWarns(guildDiscordId, ids) {
  const id = identityFilter(ids);
  if (!id) return [];
  const cutoff = expiryCutoff((await params(guildDiscordId)).warnExpiryDays);
  const filter = { ...id, removed: { $ne: true } };
  if (cutoff) filter.at = { $gt: cutoff };
  return collections.warns().find(filter).sort({ at: -1 }).toArray();
}

export async function countActiveWarns(guildDiscordId, ids) {
  return (await activeWarns(guildDiscordId, ids)).length;
}

/**
 * Registra uma advertência e devolve o estado resultante.
 *
 * @returns {Promise<{warn: object, active: number}>}
 */
export async function recordWarn(guildDiscordId, { uuid = null, username = null, discordId = null, reason, by }) {
  const warn = {
    warnId: newWarnId(),
    guildDiscordId,
    uuid,
    username,
    discordId,
    reason,
    by,
    at: new Date(),
    removed: false,
  };
  await collections.warns().insertOne(warn);

  const active = await countActiveWarns(guildDiscordId, { uuid, discordId });
  return { warn, active };
}

/** Perdoa uma advertência específica. O registro fica, marcado. */
export async function removeWarn(warnId, by, note = null) {
  const res = await collections.warns().updateOne(
    { warnId, removed: { $ne: true } },
    { $set: { removed: true, removedAt: new Date(), removedBy: by, removedReason: note } },
  );
  return res.modifiedCount === 1;
}

/** Perdoa todas as ativas de uma pessoa. Devolve quantas caíram. */
export async function clearWarns(guildDiscordId, ids, by, note = null) {
  const active = await activeWarns(guildDiscordId, ids);
  if (!active.length) return 0;
  const res = await collections.warns().updateMany(
    { warnId: { $in: active.map((w) => w.warnId) } },
    { $set: { removed: true, removedAt: new Date(), removedBy: by, removedReason: note } },
  );
  return res.modifiedCount;
}

export async function findWarn(warnId) {
  return collections.warns().findOne({ warnId });
}
