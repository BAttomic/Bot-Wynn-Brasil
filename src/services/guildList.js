/**
 * Guildas do WynnCraft que o bot rastreia, em dois papéis opostos:
 *
 *   black-list → membro dela leva o cargo de banido, em silêncio;
 *   aliada     → membro dela ganha um cargo `[TAG] Nome` próprio, além do de
 *                comunidade.
 *
 * Antes disto a black-list era UMA guilda, lida do ambiente
 * (`WYNN_BLACKLIST_GUILD_UUID/PREFIX`, com a GsW embutida no código). Banir uma
 * segunda exigia editar o `.env` e reiniciar. Esse caminho foi REMOVIDO por
 * inteiro: a lista é dado, e só o `/guilds` mexe nela.
 *
 * A chave é o `uuid`, não o prefixo — o dono de uma guilda pode trocar a TAG a
 * qualquer momento, e a regra não pode cair junto. O prefixo continua guardado
 * (é como a staff pensa nas guildas, e é o que o roster da API pede), e é
 * ressincronizado sempre que alguém adiciona ou lista.
 */
import { collections } from '../db/mongo.js';
import { wynn } from '../wynn/api.js';
import { optional } from '../config/env.js';
import { log } from '../util/log.js';

export const KIND_BLACKLIST = 'blacklist';
export const KIND_ALLY = 'ally';

/** @type {readonly string[]} */
export const GUILD_KINDS = Object.freeze([KIND_BLACKLIST, KIND_ALLY]);

export const KIND_LABEL = {
  [KIND_BLACKLIST]: 'black-list',
  [KIND_ALLY]: 'aliada',
};

/**
 * @typedef {object} TrackedGuild
 * @property {string}  uuid
 * @property {string}  prefix
 * @property {string}  name
 * @property {'blacklist'|'ally'} kind
 * @property {string?} roleId    só aliada: cargo [TAG] Nome no Discord
 * @property {Date}    addedAt
 * @property {string?} addedBy
 */

/**
 * Índice em memória. Isto é lido em TODO registro e em todo ciclo do roleSync,
 * então uma consulta por leitura seria desperdício — mesma escolha do cache de
 * `config/guildConfig.js`. Qualquer escrita aqui embaixo o invalida.
 * @type {{index: GuildIndex} | null}
 */
let cached = null;

/** Descarta o índice em memória. Chamado por toda escrita. */
export function invalidateGuildIndex() {
  cached = null;
}

/**
 * @typedef {object} GuildIndex
 * @property {Set<string>} blacklistUuids
 * @property {Set<string>} blacklistPrefixes
 * @property {Map<string, TrackedGuild>} allyByUuid
 * @property {Map<string, TrackedGuild>} allyByPrefix
 * @property {TrackedGuild[]} blacklist
 * @property {TrackedGuild[]} ally
 */

/**
 * Carrega a lista inteira em conjuntos prontos para consulta.
 * @returns {Promise<GuildIndex>}
 */
export async function loadGuildIndex() {
  if (cached) return cached.index;

  const docs = await collections.trackedGuilds().find({}).toArray();
  const index = {
    blacklistUuids: new Set(),
    blacklistPrefixes: new Set(),
    allyByUuid: new Map(),
    allyByPrefix: new Map(),
    blacklist: [],
    ally: [],
  };
  for (const g of docs) {
    if (g.kind === KIND_BLACKLIST) {
      index.blacklist.push(g);
      if (g.uuid) index.blacklistUuids.add(g.uuid);
      if (g.prefix) index.blacklistPrefixes.add(g.prefix);
    } else if (g.kind === KIND_ALLY) {
      index.ally.push(g);
      if (g.uuid) index.allyByUuid.set(g.uuid, g);
      if (g.prefix) index.allyByPrefix.set(g.prefix, g);
    }
  }
  cached = { index };
  return index;
}

/** Todos os ids de cargo de guilda aliada já criados. */
export async function allyRoleIds() {
  const { ally } = await loadGuildIndex();
  return ally.map((g) => g.roleId).filter(Boolean);
}

/** @param {'blacklist'|'ally'} [kind] @returns {Promise<TrackedGuild[]>} */
export async function listGuilds(kind = null) {
  const idx = await loadGuildIndex();
  if (kind === KIND_BLACKLIST) return idx.blacklist;
  if (kind === KIND_ALLY) return idx.ally;
  return [...idx.blacklist, ...idx.ally];
}

/** A nossa própria guilda, do ambiente. Nunca pode entrar na lista. */
function ours() {
  return { uuid: optional('WYNN_GUILD_UUID'), prefix: optional('WYNN_GUILD_PREFIX') };
}

/**
 * Adiciona (ou reclassifica) uma guilda pela TAG.
 *
 * Trocar o `kind` de uma guilda já rastreada é um `$set` no mesmo documento, e
 * não um erro: mover uma guilda de aliada para black-list (ou o contrário) é uma
 * decisão legítima da staff, e manter dois registros para o mesmo uuid seria o
 * bug — o índice único não deixaria, aliás.
 *
 * @param {{tag: string, kind: 'blacklist'|'ally', by?: string|null}} p
 * @returns {Promise<{ok: boolean, error?: string, guild?: TrackedGuild, created?: boolean, movedFrom?: string|null}>}
 */
export async function addGuild({ tag, kind, by = null }) {
  const prefix = String(tag ?? '').trim();
  if (!prefix) return { ok: false, error: 'Informe a TAG da guilda.' };
  if (!GUILD_KINDS.includes(kind)) return { ok: false, error: 'Tipo inválido.' };

  const data = await wynn.guildByPrefix(prefix).catch(() => null);
  if (!data?.uuid) {
    return { ok: false, error: `Não encontrei nenhuma guilda com a TAG **${prefix}** na API do WynnCraft.` };
  }

  const nossa = ours();
  if ((nossa.uuid && data.uuid === nossa.uuid) || (nossa.prefix && data.prefix === nossa.prefix)) {
    return { ok: false, error: 'Essa é a **nossa** guilda. Ela não entra na lista.' };
  }

  const existing = await collections.trackedGuilds().findOne({ uuid: data.uuid });
  const movedFrom = existing && existing.kind !== kind ? existing.kind : null;

  const now = new Date();
  const set = { prefix: data.prefix, name: data.name, kind, updatedAt: now };
  // Mudou de papel? O cargo de aliada não faz mais sentido; o vínculo é cortado
  // aqui, e o cargo em si fica no Discord para a staff decidir (ver removeGuild).
  if (movedFrom === KIND_ALLY) set.roleId = null;

  await collections.trackedGuilds().updateOne(
    { uuid: data.uuid },
    { $set: set, $setOnInsert: { uuid: data.uuid, addedAt: now, addedBy: by, roleId: null } },
    { upsert: true },
  );
  invalidateGuildIndex();

  const guild = await collections.trackedGuilds().findOne({ uuid: data.uuid });
  return { ok: true, guild, created: !existing, movedFrom };
}

/**
 * Tira a guilda da lista. O cargo do Discord (se aliada) NÃO é apagado: apagar
 * cargo é irreversível e leva junto o histórico de quem o teve. O documento sai,
 * o cargo para de ser distribuído, e a staff apaga à mão se quiser.
 *
 * @param {{tag?: string, uuid?: string, kind?: 'blacklist'|'ally'}} p
 * @returns {Promise<{ok: boolean, error?: string, guild?: TrackedGuild}>}
 */
export async function removeGuild({ tag = null, uuid = null, kind = null }) {
  const filter = {};
  if (uuid) filter.uuid = uuid;
  else if (tag) filter.prefix = String(tag).trim();
  else return { ok: false, error: 'Informe a TAG da guilda.' };
  if (kind) filter.kind = kind;

  const doc = await collections.trackedGuilds().findOne(filter);
  if (!doc) {
    const alvo = kind ? `na lista de ${KIND_LABEL[kind]}` : 'na lista';
    return { ok: false, error: `Não encontrei **${tag ?? uuid}** ${alvo}.` };
  }

  await collections.trackedGuilds().deleteOne({ uuid: doc.uuid });
  invalidateGuildIndex();
  return { ok: true, guild: doc };
}

/** Grava o cargo criado para uma guilda aliada. */
export async function setAllyRoleId(uuid, roleId) {
  await collections.trackedGuilds().updateOne({ uuid }, { $set: { roleId } });
  invalidateGuildIndex();
}

/** Atualiza prefixo/nome quando a guilda se renomeia no jogo. */
export async function refreshGuildIdentity(uuid, { prefix, name }) {
  await collections.trackedGuilds().updateOne({ uuid }, { $set: { prefix, name, updatedAt: new Date() } });
  invalidateGuildIndex();
}

/**
 * Aviso de boot: black-list vazia significa que NINGUÉM está sendo banido
 * automaticamente. Não é erro — um servidor novo começa assim — mas é o tipo de
 * estado que passa despercebido justamente porque o auto-ban é silencioso por
 * projeto: sem nenhuma mensagem em canal nenhum, não há sintoma visível.
 */
export async function warnIfEmpty() {
  const n = await collections.trackedGuilds().countDocuments({ kind: KIND_BLACKLIST });
  if (!n) log.warn('Nenhuma guilda na black-list: o auto-ban está inativo. Use /guilds blacklist add tag:<TAG>.');
  return n;
}
