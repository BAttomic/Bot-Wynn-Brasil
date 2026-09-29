import { collections } from '../db/mongo.js';
import { log } from '../util/log.js';
import { stripNickTag } from '../util/format.js';

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

/**
 * Casa por qualquer um dos dois lados da identidade. Aceita um de cada ou listas
 * (`uuids`, `discordIds`), para quem já resolveu a pessoa inteira.
 * @returns {object|null}
 */
function identityFilter({ uuid = null, discordId = null, uuids = [], discordIds = [] }) {
  const us = [...new Set([uuid, ...uuids].filter(Boolean))];
  const ds = [...new Set([discordId, ...discordIds].filter(Boolean))];
  const or = [];
  if (us.length) or.push({ uuid: { $in: us } });
  if (ds.length) or.push({ discordIds: { $in: ds } });
  return or.length ? { $or: or } : null;
}

/**
 * TUDO o que é da mesma pessoa, a partir de um Discord e/ou uma conta do jogo.
 *
 * Segue os vínculos até não achar nada novo: a conta leva ao Discord vinculado,
 * o Discord leva às contas vinculadas a ele, e assim por diante. Hoje o vínculo
 * é 1:1 e isso para na primeira volta; com várias contas por Discord, o mesmo
 * laço já pega todas. É o que faz ban e unban valerem para a pessoa, e não para
 * a única conta que a staff digitou.
 *
 * Com `viaBans`, os registros de ban que casarem também entram — para o unban
 * desfazer a teia inteira, e para banir por um Discord sem vínculo que já
 * apareceu num ban.
 *
 * @param {{uuid?: string|null, discordId?: string|null, username?: string|null, viaBans?: boolean}} seed
 * @returns {Promise<{uuids: string[], discordIds: string[], nomes: Map<string, string>}>}
 *   `nomes`: uuid -> nick do jogo (sem TAG)
 */
export async function resolveIdentity({ uuid = null, discordId = null, username = null, viaBans = false }) {
  const uuids = new Set(uuid ? [uuid] : []);
  const discordIds = new Set(discordId ? [discordId] : []);
  const nomes = new Map();
  if (uuid && username) nomes.set(uuid, stripNickTag(username));

  for (let volta = 0; volta < 10; volta += 1) {
    const antes = uuids.size + discordIds.size;
    const or = [];
    if (uuids.size) or.push({ uuid: { $in: [...uuids] } });
    if (discordIds.size) or.push({ discordId: { $in: [...discordIds] } });
    if (!or.length) break;

    const links = await collections
      .members()
      .find({ $or: or }, { projection: { uuid: 1, discordId: 1, username: 1 } })
      .toArray();
    for (const l of links) {
      if (l.uuid) uuids.add(l.uuid);
      if (l.discordId) discordIds.add(l.discordId);
      if (l.uuid && l.username && !nomes.has(l.uuid)) nomes.set(l.uuid, stripNickTag(l.username));
    }

    if (viaBans) {
      const id = identityFilter({ uuids: [...uuids], discordIds: [...discordIds] });
      const bans = await collections.bans().find(id, { projection: { uuid: 1, discordIds: 1, usernames: 1 } }).toArray();
      for (const b of bans) {
        if (b.uuid) uuids.add(b.uuid);
        for (const d of b.discordIds || []) discordIds.add(d);
        const nome = (b.usernames || []).map(stripNickTag).find(Boolean);
        if (b.uuid && nome && !nomes.has(b.uuid)) nomes.set(b.uuid, nome);
      }
    }

    if (uuids.size + discordIds.size === antes) break;
  }
  return { uuids: [...uuids], discordIds: [...discordIds], nomes };
}

/** Nicks do jogo de um registro, sem TAG e sem repetição, para exibir. */
export function banNicks(ban) {
  return [...new Set((ban?.usernames || []).map(stripNickTag).filter(Boolean))];
}

export async function findBan(ids = {}) {
  const id = identityFilter(ids);
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
export async function findExemption(ids = {}) {
  const id = identityFilter(ids);
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
  discordIds = [],
  reason,
  by = null,
  override = false,
}) {
  if (!uuid) return null;
  const ds = [...new Set([discordId, ...discordIds].filter(Boolean))];
  // Chokepoint único: qualquer caminho automático (roleSync, reconciliação,
  // registro) passa por aqui, então a isenção não depende de cada um lembrar.
  if (!override && (await findExemption({ uuid, discordIds: ds }))) return false;

  const now = new Date();

  // O nick do JOGO, nunca o apelido do Discord: `[GsW] Fulano` gravado ao lado
  // de `Fulano` fazia a mesma pessoa aparecer duas vezes na lista de bans.
  const nick = stripNickTag(username);
  const addToSet = {};
  if (nick) addToSet.usernames = nick;
  if (ds.length) addToSet.discordIds = { $each: ds };

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
export async function removeBan({ uuid = null, discordId = null, uuids = [], discordIds = [], by = null } = {}) {
  const id = identityFilter({ uuid, discordId, uuids, discordIds });
  if (!id) return 0;
  const res = await collections
    .bans()
    .updateMany({ ...id, ...ACTIVE }, { $set: { exempt: true, exemptAt: new Date(), exemptBy: by } });
  if (res.modifiedCount) {
    log.info(`Banimento removido — isenção gravada (${res.modifiedCount} registro(s)).`);
  }
  return res.modifiedCount;
}

/**
 * Bane a PESSOA: toda conta do jogo e todo Discord ligados ao alvo (ver
 * resolveIdentity). Cada conta tem o próprio registro, todos com todos os
 * Discords.
 *
 * @returns {Promise<{uuids: string[], discordIds: string[], nomes: Map<string,string>, hadExemption: boolean}|null>}
 *   null = nenhuma conta do jogo achada (o ban é indexado por conta)
 */
export async function banPerson({ uuid = null, discordId = null, username = null, reason, by = null, override = false }) {
  const pessoa = await resolveIdentity({ uuid, discordId, username, viaBans: !uuid });
  if (!pessoa.uuids.length) return null;
  const hadExemption = !!(await findExemption({ uuids: pessoa.uuids, discordIds: pessoa.discordIds }));
  for (const u of pessoa.uuids) {
    await recordBan({ uuid: u, username: pessoa.nomes.get(u) ?? null, discordIds: pessoa.discordIds, reason, by, override });
  }
  return { ...pessoa, hadExemption };
}

/**
 * Isenta a PESSOA inteira: toda conta e todo Discord ligados ao alvo, e todo
 * registro de ban que casar com qualquer um deles.
 * @returns {Promise<{removed: number, uuids: string[], discordIds: string[], nomes: Map<string,string>}>}
 */
export async function unbanPerson({ uuid = null, discordId = null, username = null, by = null }) {
  const pessoa = await resolveIdentity({ uuid, discordId, username, viaBans: true });
  const removed = await removeBan({ uuids: pessoa.uuids, discordIds: pessoa.discordIds, by });
  return { removed, ...pessoa };
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
