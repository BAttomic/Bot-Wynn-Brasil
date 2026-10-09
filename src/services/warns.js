import { randomUUID } from 'node:crypto';
import { collections } from '../db/mongo.js';

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
// Cada warn tem uma GRAVIDADE, que diz quantos pontos ele vale e por quanto
// tempo conta (GRAVIDADES). A validade NÃO é congelada na criação: igual ao
// livro-razão de pontos, o que se guarda é o fato cru (quando aconteceu e a
// gravidade) e a regra é aplicada na hora de ler. Mudar a tabela muda todo o
// histórico de uma vez, em vez de valer só para os warns futuros — que seria
// uma regra invisível, diferente para cada linha, impossível de explicar a
// quem foi advertido.

/**
 * Quanto cada gravidade pesa e por quantos meses conta. Fixo no código, como os
 * outros parâmetros da staff. Warn de antes da gravidade conta como baixa.
 */
export const GRAVIDADES = Object.freeze({
  baixa: Object.freeze({ label: 'Baixa', pontos: 1, meses: 1 }),
  media: Object.freeze({ label: 'Média', pontos: 2, meses: 2 }),
  grave: Object.freeze({ label: 'Grave', pontos: 3, meses: 3 }),
});

const MAIS_LONGA = Math.max(...Object.values(GRAVIDADES).map((g) => g.meses));

/** A gravidade de um warn. Sem o campo (warn antigo), é baixa. */
export function gravidadeDe(w) {
  return GRAVIDADES[w?.severity] ?? GRAVIDADES.baixa;
}

/**
 * `n` meses de calendário depois (ou antes, com `n` negativo). Dia que não
 * existe no mês de chegada cai no último: 31/jan + 1 mês = 28 ou 29/fev.
 */
export function addMonths(date, n) {
  const d = new Date(date);
  const dia = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const ultimo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dia, ultimo));
  return d;
}

/** Quando o warn deixa de contar: os meses da gravidade, a partir de quando foi dado. */
export function expiresAt(w) {
  return addMonths(w.at, gravidadeDe(w).meses);
}

/** Soma dos pontos de uma lista de warns. */
export function pontosDe(warns) {
  return warns.reduce((s, w) => s + gravidadeDe(w).pontos, 0);
}

/** Id curto e sorteável, para caber num `/warn remove id:`. */
function newWarnId() {
  return randomUUID().replace(/-/g, '').slice(0, 8);
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
 * @returns {Promise<Array<object & {expired: boolean, active: boolean, expiresAt: Date}>>}
 */
export async function warnHistory(guildDiscordId, ids, limit = 25, now = new Date()) {
  const id = identityFilter(ids);
  if (!id) return [];
  const docs = await collections.warns().find(id).sort({ at: -1 }).limit(limit).toArray();
  return docs.map((w) => {
    const fim = expiresAt(w);
    const expired = fim <= now;
    return { ...w, expiresAt: fim, expired, active: !w.removed && !expired };
  });
}

/** Só as que ainda contam: não perdoadas e dentro do prazo da gravidade. */
export async function activeWarns(guildDiscordId, ids, now = new Date()) {
  const id = identityFilter(ids);
  if (!id) return [];
  // O banco corta pelo prazo mais longo (com folga); o prazo de cada uma, que
  // depende da gravidade, é conferido aqui.
  const corte = new Date(addMonths(now, -MAIS_LONGA).getTime() - 86_400_000);
  const docs = await collections
    .warns()
    .find({ ...id, removed: { $ne: true }, at: { $gt: corte } })
    .sort({ at: -1 })
    .toArray();
  return docs.filter((w) => expiresAt(w) > now);
}

/** Quantas advertências e quantos pontos ativos a pessoa tem. */
export async function activeSummary(guildDiscordId, ids) {
  const ativas = await activeWarns(guildDiscordId, ids);
  return { active: ativas.length, pontos: pontosDe(ativas) };
}

export async function countActiveWarns(guildDiscordId, ids) {
  return (await activeWarns(guildDiscordId, ids)).length;
}

/**
 * Registra uma advertência e devolve o estado resultante.
 *
 * @param {{severity: keyof GRAVIDADES}} args
 * @returns {Promise<{warn: object, active: number, pontos: number}>}
 */
export async function recordWarn(guildDiscordId, { uuid = null, username = null, discordId = null, reason, by, severity = 'baixa' }) {
  if (!GRAVIDADES[severity]) throw new Error(`Gravidade inválida: ${severity}`);
  const warn = {
    warnId: newWarnId(),
    guildDiscordId,
    uuid,
    username,
    discordId,
    reason,
    severity,
    by,
    at: new Date(),
    removed: false,
  };
  await collections.warns().insertOne(warn);

  return { warn, ...(await activeSummary(guildDiscordId, { uuid, discordId })) };
}

/**
 * Corrige a gravidade e/ou o motivo de uma advertência não perdoada. O que ela
 * era antes vai para `edits`, com quem mudou e quando: o histórico não perde a
 * versão original. O prazo acompanha a gravidade nova, contado da data
 * original — editar não reinicia a contagem.
 *
 * @param {{severity?: string|null, reason?: string|null}} mudancas
 * @returns {Promise<object|null>} a advertência editada, ou null se não há o
 *   que editar (não existe, foi perdoada ou nada mudou)
 */
export async function editWarn(warnId, { severity = null, reason = null }, by) {
  if (severity && !GRAVIDADES[severity]) throw new Error(`Gravidade inválida: ${severity}`);
  const atual = await collections.warns().findOne({ warnId, removed: { $ne: true } });
  if (!atual) return null;

  const $set = {};
  if (severity && severity !== (atual.severity ?? 'baixa')) $set.severity = severity;
  if (reason && reason !== atual.reason) $set.reason = reason;
  if (!Object.keys($set).length) return null;

  const antes = { severity: atual.severity ?? 'baixa', reason: atual.reason };
  // Condicional no estado lido: duas edições ao mesmo tempo não se atropelam.
  return collections.warns().findOneAndUpdate(
    // `null` casa também o campo ausente, do warn de antes da gravidade.
    { warnId, removed: { $ne: true }, severity: atual.severity ?? null, reason: atual.reason },
    { $set, $push: { edits: { at: new Date(), by, antes } } },
    { returnDocument: 'after' },
  );
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
