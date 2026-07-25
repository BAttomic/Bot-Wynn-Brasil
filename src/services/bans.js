import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';

// Lista de banimentos, indexada pelos DOIS lados da identidade: o UUID da conta
// do WynnCraft e o ID do Discord. Basta um deles bater para o banimento pegar.
//
// Isso fecha as duas rotas de fuga. Trocar de conta do Minecraft não adianta,
// porque o Discord continua marcado. Trocar de Discord também não, porque o UUID
// continua marcado. E cada novo par visto é anexado ao mesmo registro, então a
// teia só cresce.
//
// O banimento é PERMANENTE: sair da guilda proibida não o desfaz. Só a staff
// remove, com /ban remove.

export const BAN_REASON_BLACKLIST_GUILD = 'Membro da guilda da black-list';

export async function findBan({ uuid = null, discordId = null } = {}) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordIds: discordId });
  if (!or.length) return null;
  return collections.bans().findOne({ $or: or });
}

export async function isBanned(ids) {
  return !!(await findBan(ids));
}

// Cria ou reforça um banimento. Chamar de novo com um nick ou Discord novo
// apenas anexa a identidade ao registro existente.
export async function recordBan({ uuid, username = null, discordId = null, reason, by = null }) {
  if (!uuid) return null;
  const now = new Date();

  const addToSet = {};
  if (username) addToSet.usernames = username;
  if (discordId) addToSet.discordIds = discordId;

  const update = {
    $set: { lastSeenAt: now },
    $setOnInsert: { uuid, firstBannedAt: now, reason, bannedBy: by },
  };
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;

  await collections.bans().updateOne({ uuid }, update, { upsert: true });
  return true;
}

// Remove o banimento por UUID ou por Discord. Devolve quantos registros caíram.
export async function removeBan({ uuid = null, discordId = null } = {}) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordIds: discordId });
  if (!or.length) return 0;
  const res = await collections.bans().deleteMany({ $or: or });
  if (res.deletedCount) log.info(`Banimento removido (${res.deletedCount} registro(s)).`);
  return res.deletedCount;
}

export async function listBans(limit = 25) {
  return collections.bans().find({}).sort({ firstBannedAt: -1 }).limit(limit).toArray();
}

export async function countBans() {
  return collections.bans().countDocuments({});
}

// Carrega a lista inteira em memória. O roleSync percorre dezenas de membros a
// cada ciclo; uma consulta só é melhor que uma por membro.
export async function loadBanIndex() {
  const bans = await collections.bans().find({}).toArray();
  return {
    uuids: new Set(bans.map((b) => b.uuid)),
    discordIds: new Set(bans.flatMap((b) => b.discordIds || [])),
  };
}
