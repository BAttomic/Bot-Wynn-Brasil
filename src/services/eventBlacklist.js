/**
 * Lista negra global de eventos.
 *
 * Separada da lista de banimentos (`services/bans.js`) de propósito: banir da
 * guilda e barrar de premiação são decisões diferentes. Quem está aqui continua
 * membro normal — só não pontua nem aparece em ranking de evento nenhum.
 *
 * A chave é o `uuid` do WynnCraft, porque é ele que o placar usa. O `discordId`
 * fica junto só para a staff conseguir consultar pelo Discord.
 */
import { collections } from '../db/mongo.js';

/** Registra (ou atualiza) o bloqueio de um jogador. */
export async function blockMember({ uuid, username = null, discordId = null, reason, by }) {
  if (!uuid) throw new Error('blockMember exige uuid');
  const now = new Date();
  const res = await collections.eventBlacklist().updateOne(
    { uuid },
    {
      $set: { reason, by, updatedAt: now },
      $setOnInsert: { uuid, blockedAt: now },
      // Nick e Discord mudam com o tempo; guardamos o histórico para a staff
      // reconhecer a pessoa depois.
      ...(username || discordId
        ? {
            $addToSet: {
              ...(username ? { usernames: username } : {}),
              ...(discordId ? { discordIds: discordId } : {}),
            },
          }
        : {}),
    },
    { upsert: true },
  );
  return { created: res.upsertedCount > 0 };
}

/** Remove o bloqueio. Devolve quantos registros saíram. */
export async function unblockMember({ uuid = null, discordId = null } = {}) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordIds: discordId });
  if (!or.length) return 0;
  const res = await collections.eventBlacklist().deleteMany({ $or: or });
  return res.deletedCount;
}

export async function findBlock({ uuid = null, discordId = null } = {}) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordIds: discordId });
  if (!or.length) return null;
  return collections.eventBlacklist().findOne({ $or: or });
}

export function listBlocks(limit = 25) {
  return collections.eventBlacklist().find({}).sort({ blockedAt: -1 }).limit(limit).toArray();
}

export function countBlocks() {
  return collections.eventBlacklist().countDocuments({});
}

/**
 * Só os uuids, para filtrar a apuração.
 *
 * A lista é curta por natureza (decisão manual da staff), então ler inteiro sai
 * mais barato que cruzar coleção a cada apuração.
 */
export async function blockedUuids() {
  const rows = await collections.eventBlacklist().find({}, { projection: { uuid: 1 } }).toArray();
  return rows.map((r) => r.uuid);
}

export async function isEventBlocked(uuid) {
  if (!uuid) return false;
  return !!(await collections.eventBlacklist().findOne({ uuid }, { projection: { _id: 1 } }));
}
