/**
 * Cargo das guildas aliadas: um cargo só, `[WnBR] Allies`, para todo aliado.
 *
 * Já foi um `[TAG] Nome` por guilda, criado, renomeado e reposicionado pelo bot.
 * O servidor passou a ter um cargo único, e o bot recriava os cargos por guilda
 * que a staff apagava. Agora ele não cria cargo nenhum: aplica o fixo.
 *
 * A guilda de origem continua visível pelo apelido (`[TAG] Fulano`, ver
 * syncNickname em services/registration.js). O aliado também carrega o cargo
 * de comunidade.
 */
import { loadGuildIndex, setAllyRoleId, refreshGuildIdentity } from './guildList.js';

/** `[WnBR] Allies`. */
export const ALLIES_ROLE_ID = '1554204990451753122';

/** Nome de exibição de uma guilda aliada, para as mensagens da staff. */
export function allyRoleName(doc) {
  return `[${doc.prefix}] ${doc.name}`;
}

/**
 * O cargo de aliado, para qualquer guilda aliada. Grava o id no documento da
 * guilda para `allyRoleIds` convergir: o cargo por guilda antigo sai da lista
 * e deixa de ser tratado como cargo de aliada.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} _cfg  mantido pela assinatura; o cargo é fixo
 * @param {import('./guildList.js').TrackedGuild} doc
 * @returns {Promise<string|null>} id do cargo, ou null se ele sumiu do servidor
 */
export async function ensureAllyRole(guild, _cfg, doc) {
  if (!guild.roles.cache.has(ALLIES_ROLE_ID)) return null;
  if (doc.roleId !== ALLIES_ROLE_ID) await setAllyRoleId(doc.uuid, ALLIES_ROLE_ID);
  return ALLIES_ROLE_ID;
}

/**
 * Garante TODOS os cargos de aliada de uma vez. Roda no ciclo do roleSync e logo
 * depois de `/guilds ally add`.
 *
 * @returns {Promise<Map<string, string>>} uuid da guilda -> id do cargo
 */
export async function ensureAllyRoles(guild, cfg) {
  const { ally } = await loadGuildIndex();
  const out = new Map();
  for (const doc of ally) {
    const id = await ensureAllyRole(guild, cfg, doc);
    if (id) out.set(doc.uuid, id);
  }
  return out;
}

/**
 * Deixa o membro com EXATAMENTE um cargo de aliada (ou nenhum).
 *
 * Passar `wantedId = null` é o caminho de remoção — saiu da aliada, entrou na
 * nossa guilda, ou foi banido. É por isso que `applyClassificationRoles` chama
 * isto sempre, e não só quando o `kind` é 'ally'.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {string[]} knownIds  todos os cargos de aliada existentes
 * @param {string?} wantedId
 */
export async function applyAllyRole(member, knownIds, wantedId = null) {
  if (!member?.roles?.add) return;
  for (const id of knownIds) {
    if (id === wantedId) continue;
    if (member.roles.cache.has(id)) await member.roles.remove(id).catch(() => {});
  }
  if (wantedId && !member.roles.cache.has(wantedId)) {
    await member.roles.add(wantedId).catch(() => {});
  }
}

/**
 * Ressincroniza prefixo/nome da aliada a partir do roster já buscado, e devolve
 * o nome do cargo atualizado. Chamado por quem já pagou a requisição do roster.
 */
export async function syncAllyIdentity(doc, apiGuild) {
  if (!apiGuild) return doc;
  if (apiGuild.prefix === doc.prefix && apiGuild.name === doc.name) return doc;
  await refreshGuildIdentity(doc.uuid, { prefix: apiGuild.prefix, name: apiGuild.name });
  return { ...doc, prefix: apiGuild.prefix, name: apiGuild.name };
}
