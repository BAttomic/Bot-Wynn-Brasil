/**
 * Cargos das guildas aliadas: um `[TAG] Nome` por guilda, criado pelo bot e
 * posicionado ENTRE o cargo de membro da nossa guilda e o de comunidade.
 *
 * O lugar na lista é a mensagem: o aliado aparece logo abaixo dos nossos e logo
 * acima do público geral. Ele também carrega o cargo de comunidade — o `[TAG]`
 * identifica, não dá acesso, e por isso nenhuma permissão de canal precisa ser
 * escrita para ele (ver `scripts/lockdown-banned.js`, que só cuida do banido).
 *
 * Duas falhas são esperadas e silenciosas, como em `syncNickname` e
 * `grantWarRole`: o bot não mexe em cargo acima do próprio, e não posiciona nada
 * se o cargo de comunidade não estiver configurado. Nos dois casos fica um
 * `log.warn` e a vida segue — nada disso pode derrubar um registro.
 */
import { loadGuildIndex, setAllyRoleId, refreshGuildIdentity } from './guildList.js';
import { log } from '../util/log.js';

/** Nome canônico do cargo de uma guilda aliada. */
export function allyRoleName(doc) {
  return `[${doc.prefix}] ${doc.name}`;
}

/**
 * Posição desejada: uma casa acima do cargo de comunidade. Devolve `null` quando
 * não dá para calcular (comunidade não configurada) ou quando o bot não alcança.
 */
function targetPosition(guild, cfg) {
  const community = cfg.roles?.community ? guild.roles.cache.get(cfg.roles.community) : null;
  if (!community) return null;
  const wanted = community.position + 1;
  const me = guild.members.me?.roles?.highest;
  // Criar/mover um cargo na altura do próprio cargo do bot (ou acima) é recusado
  // pelo Discord. Melhor não tentar do que estourar uma exceção por registro.
  if (me && me.position <= wanted) {
    log.warn(`Cargo de aliada não pode ir para a posição ${wanted}: o cargo do bot está em ${me.position}.`);
    return null;
  }
  return wanted;
}

/** O cargo está entre o de membro da guilda e o de comunidade? */
function wellPlaced(role, guild, cfg) {
  const community = cfg.roles?.community ? guild.roles.cache.get(cfg.roles.community) : null;
  const guildMember = cfg.roles?.guildMember ? guild.roles.cache.get(cfg.roles.guildMember) : null;
  if (!community) return true; // sem referência, qualquer lugar serve
  if (role.position <= community.position) return false;
  if (guildMember && role.position >= guildMember.position) return false;
  return true;
}

/**
 * Garante o cargo de uma guilda aliada: acha por id, senão por nome, senão cria.
 * Renomeia se a guilda trocou de TAG ou de nome, e reposiciona se saiu do lugar.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} cfg  saída de getConfig()
 * @param {import('./guildList.js').TrackedGuild} doc
 * @returns {Promise<string|null>} id do cargo, ou null se não deu
 */
export async function ensureAllyRole(guild, cfg, doc) {
  const name = allyRoleName(doc);
  let role = doc.roleId ? guild.roles.cache.get(doc.roleId) : null;
  if (!role) role = guild.roles.cache.find((r) => r.name === name);

  if (!role) {
    const community = cfg.roles?.community ? guild.roles.cache.get(cfg.roles.community) : null;
    const position = targetPosition(guild, cfg);
    try {
      role = await guild.roles.create({
        name,
        mentionable: true,
        // Acompanha o cargo de comunidade: se ele aparece separado na lista de
        // membros, o de aliado também aparece.
        hoist: community?.hoist ?? false,
        ...(position === null ? {} : { position }),
        reason: 'Cargo de guilda aliada criado automaticamente pelo bot',
      });
      log.info(`Cargo de aliada criado: "${name}" (${role.id}).`);
    } catch (e) {
      log.warn(`Não consegui criar o cargo de aliada "${name}": ${e.message}`);
      return null;
    }
  } else {
    if (role.name !== name) await role.setName(name, 'Guilda aliada renomeada').catch(() => {});
    if (!wellPlaced(role, guild, cfg)) {
      const position = targetPosition(guild, cfg);
      if (position !== null) {
        await role
          .setPosition(position, { reason: 'Reposicionando cargo de guilda aliada' })
          .catch((e) => log.warn(`Não consegui reposicionar "${name}": ${e.message}`));
      }
    }
  }

  if (doc.roleId !== role.id) await setAllyRoleId(doc.uuid, role.id);
  return role.id;
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
