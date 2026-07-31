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
//
// E `/ban remove` não APAGA o registro — marca `exempt`. A diferença importa,
// porque a regra automática contra a GsW não é um evento único: o roleSync roda
// a cada 10 min e re-bane todo membro da GsW que ainda não esteja na lista.
// Apagar o registro devolvia a pessoa exatamente ao estado que dispara a regra,
// e o desbanimento durava até o próximo ciclo. O tombstone é o que faz a decisão
// da staff sobreviver ao job.
//
// A isenção vence a regra AUTOMÁTICA, nunca a staff: `/ban add` passa
// `override` e derruba a isenção. Ela também herda a teia de identidades — quem
// foi isento continua isento trocando de conta ou de Discord, pelo mesmo motivo
// que o banimento pegava os dois lados.

export const BAN_REASON_BLACKLIST_GUILD = 'Membro da guilda da black-list';

/** Registros que ainda valem. Um isento continua no banco, mas não bane. */
const ACTIVE = { exempt: { $ne: true } };

/** Casa por qualquer um dos dois lados da identidade. @returns {object|null} */
function identityFilter({ uuid = null, discordId = null }) {
  const or = [];
  if (uuid) or.push({ uuid });
  if (discordId) or.push({ discordIds: discordId });
  return or.length ? { $or: or } : null;
}

export async function findBan({ uuid = null, discordId = null } = {}) {
  const id = identityFilter({ uuid, discordId });
  if (!id) return null;
  return collections.bans().findOne({ ...id, ...ACTIVE });
}

export async function isBanned(ids) {
  return !!(await findBan(ids));
}

/**
 * Isenção concedida pela staff. Quem tem isso não pode ser banido de novo pela
 * regra automática da GsW.
 */
export async function findExemption({ uuid = null, discordId = null } = {}) {
  const id = identityFilter({ uuid, discordId });
  if (!id) return null;
  return collections.bans().findOne({ ...id, exempt: true });
}

export async function isExempt(ids) {
  return !!(await findExemption(ids));
}

/**
 * Cria ou reforça um banimento. Chamar de novo com um nick ou Discord novo
 * apenas anexa a identidade ao registro existente.
 *
 * @param {object} p
 * @param {boolean} [p.override] ban EXPLÍCITO da staff: reescreve o motivo e
 *   derruba uma isenção anterior. Sem isto, um alvo isento é recusado — é o que
 *   impede o roleSync de desfazer o `/ban remove` no ciclo seguinte.
 * @returns {Promise<boolean|null>} false = recusado por isenção
 */
export async function recordBan({
  uuid,
  username = null,
  discordId = null,
  reason,
  by = null,
  override = false,
}) {
  if (!uuid) return null;
  // Chokepoint único: qualquer caminho automático (roleSync, reconciliação,
  // registro) passa por aqui, então a isenção não depende de cada um lembrar.
  if (!override && (await findExemption({ uuid, discordId }))) return false;

  const now = new Date();

  const addToSet = {};
  if (username) addToSet.usernames = username;
  if (discordId) addToSet.discordIds = discordId;

  const update = { $set: { lastSeenAt: now }, $setOnInsert: { uuid, firstBannedAt: now } };
  if (override) {
    // `reason` não pode estar nos dois operadores — o Mongo recusa o conflito de
    // caminho. No ban da staff ele é $set mesmo: o motivo novo é o que vale.
    update.$set.reason = reason;
    update.$set.bannedBy = by;
    update.$unset = { exempt: '', exemptAt: '', exemptBy: '' };
  } else {
    update.$setOnInsert.reason = reason;
    update.$setOnInsert.bannedBy = by;
  }
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;

  await collections.bans().updateOne({ uuid }, update, { upsert: true });
  return true;
}

/**
 * Isenta por UUID ou por Discord. O registro NÃO é apagado: vira tombstone, para
 * a regra automática da GsW não recriá-lo. Devolve quantos foram isentados.
 */
export async function removeBan({ uuid = null, discordId = null, by = null } = {}) {
  const id = identityFilter({ uuid, discordId });
  if (!id) return 0;
  const res = await collections
    .bans()
    .updateMany({ ...id, ...ACTIVE }, { $set: { exempt: true, exemptAt: new Date(), exemptBy: by } });
  if (res.modifiedCount) {
    log.info(`Banimento removido — isenção gravada (${res.modifiedCount} registro(s)).`);
  }
  return res.modifiedCount;
}

export async function listBans(limit = 25) {
  return collections.bans().find(ACTIVE).sort({ firstBannedAt: -1 }).limit(limit).toArray();
}

export async function countBans() {
  return collections.bans().countDocuments(ACTIVE);
}

export async function listExemptions(limit = 25) {
  return collections.bans().find({ exempt: true }).sort({ exemptAt: -1 }).limit(limit).toArray();
}

export async function countExemptions() {
  return collections.bans().countDocuments({ exempt: true });
}

/**
 * Carrega a lista inteira em memória. O roleSync percorre dezenas de membros a
 * cada ciclo; uma consulta só é melhor que uma por membro.
 *
 * Os isentos vêm em conjuntos SEPARADOS: quem consulta `uuids`/`discordIds` está
 * perguntando "está banido?", e a resposta para um isento é não.
 */
export async function loadBanIndex() {
  const docs = await collections.bans().find({}).toArray();
  const index = {
    uuids: new Set(),
    discordIds: new Set(),
    exemptUuids: new Set(),
    exemptDiscordIds: new Set(),
  };
  for (const b of docs) {
    const uuids = b.exempt ? index.exemptUuids : index.uuids;
    const discordIds = b.exempt ? index.exemptDiscordIds : index.discordIds;
    if (b.uuid) uuids.add(b.uuid);
    for (const id of b.discordIds || []) discordIds.add(id);
  }
  return index;
}

/** Consulta de isenção sobre um índice já carregado. */
export function exemptInIndex(index, { uuid = null, discordId = null } = {}) {
  return (
    (!!uuid && index.exemptUuids.has(uuid)) || (!!discordId && index.exemptDiscordIds.has(discordId))
  );
}
