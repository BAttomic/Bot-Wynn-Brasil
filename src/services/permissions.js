/**
 * Quem pode o quê — num lugar só.
 *
 * Antes, cada comando tinha o próprio `isStaff`, com regras diferentes
 * (Gerenciar Servidor, `voterRoles` do /config, rank do jogo). Com os Chefes sem
 * Administrador, várias delas passaram a barrar a própria staff. Agora a regra é
 * por CARGO, fixa, em níveis que se incluem de cima para baixo:
 *
 *   fundador      Fundador
 *   chefe         + Chefe (Staff)
 *   estrategista  + Estrategista (Staff)
 *   staff         + Capitão (Staff) e WnBR Guild Staff
 *   todos         qualquer um
 *
 * O dono do servidor passa em tudo: ele não pode ficar trancado do lado de fora.
 *
 * O comando de barra é conferido no roteador (commandLoader), por COMMAND_ACCESS.
 * Botões e menus são conferidos por quem os trata, com `hasLevel`, porque um
 * mesmo prefixo mistura ação pública e ação de staff.
 */

export const ROLE = Object.freeze({
  fundador: '1268208310423781426',
  chefeStaff: '1554224233721372692',
  estrategistaStaff: '1268208318946742312',
  capitaoStaff: '1268208319865159773',
  guildStaff: '1262574400587169863',
  ocioso: '1531488822708273152',
});

export const LEVEL = Object.freeze({
  FUNDADOR: 'fundador',
  CHEFE: 'chefe',
  ESTRATEGISTA: 'estrategista',
  STAFF: 'staff',
  TODOS: 'todos',
});

const ROLES_BY_LEVEL = Object.freeze({
  fundador: [ROLE.fundador],
  chefe: [ROLE.fundador, ROLE.chefeStaff],
  estrategista: [ROLE.fundador, ROLE.chefeStaff, ROLE.estrategistaStaff],
  staff: [ROLE.fundador, ROLE.chefeStaff, ROLE.estrategistaStaff, ROLE.capitaoStaff, ROLE.guildStaff],
});

const LEVEL_LABEL = Object.freeze({
  fundador: 'o Fundador',
  chefe: 'Chefe (Staff) ou acima',
  estrategista: 'Estrategista (Staff) ou acima',
  staff: 'a Staff',
});

/**
 * Os ids de cargo de um membro. A interação às vezes traz o membro "cru" da API
 * (lista de ids) em vez do GuildMember do discord.js.
 * @returns {string[]}
 */
function roleIdsOf(member) {
  if (!member?.roles) return [];
  if (Array.isArray(member.roles)) return member.roles;
  return [...(member.roles.cache?.keys?.() ?? [])];
}

/**
 * @param {import('discord.js').GuildMember | object | null} member
 * @param {string} level  um de LEVEL
 */
export function hasLevel(member, level) {
  if (level === LEVEL.TODOS) return true;
  if (!member) return false;
  const id = member.id ?? member.user?.id;
  if (id && member.guild?.ownerId === id) return true;
  const ids = roleIdsOf(member);
  return (ROLES_BY_LEVEL[level] ?? []).some((r) => ids.includes(r));
}

/** Pode votar em candidatura e promoção: Chefe (Staff), e nunca Ocioso. */
export function canVote(member) {
  const ids = roleIdsOf(member);
  return ids.includes(ROLE.chefeStaff) && !ids.includes(ROLE.ocioso);
}

/** A resposta de quem não tem o nível — sempre efêmera. */
export function deniedMessage(level) {
  return `Sem permissão: só ${LEVEL_LABEL[level] ?? 'a staff'} pode usar isto.`;
}

/**
 * Confere o nível e, faltando, responde à interação. Devolve se pode seguir.
 * @param {import('discord.js').Interaction} interaction
 * @param {string} level
 */
export async function requireLevel(interaction, level) {
  if (hasLevel(interaction.member, level)) return true;
  const payload = { content: deniedMessage(level), ephemeral: true };
  const p = interaction.deferred || interaction.replied ? interaction.followUp(payload) : interaction.reply(payload);
  await p.catch(() => {});
  return false;
}

const { FUNDADOR, CHEFE, ESTRATEGISTA, STAFF, TODOS } = LEVEL;

/** Corrigir recompensa reescreve contador; só consultar e entregar é de staff. */
function rewardAccess(interaction) {
  const corrige =
    interaction.options.getInteger('ajustar') !== null || interaction.options.getInteger('entregues') !== null;
  return corrige ? CHEFE : STAFF;
}

/**
 * Nível de cada comando de barra: um nível para o comando inteiro, um por
 * subcomando (ou grupo), ou uma função. O que não está aqui é de todos.
 */
const COMMAND_ACCESS = Object.freeze({
  ban: { add: CHEFE, remove: FUNDADOR, list: STAFF, check: STAFF },
  warn: { add: ESTRATEGISTA, remove: ESTRATEGISTA, clear: ESTRATEGISTA, list: STAFF },
  unlink: CHEFE,
  forcelink: CHEFE,
  reconciliar: CHEFE,
  guilds: CHEFE,
  config: CHEFE,
  registro: CHEFE,
  season: { start: CHEFE, end: CHEFE },
  points: { add: CHEFE, recalcular: CHEFE, apurar: CHEFE },
  tome: { grant: STAFF, corrigir: CHEFE },
  aspects: rewardAccess,
  esmeraldas: rewardAccess,
  verificar: STAFF,
  fila: STAFF,
  loan: STAFF,
  evento: { criar: ESTRATEGISTA, encerrar: ESTRATEGISTA, cancelar: ESTRATEGISTA, apurar: ESTRATEGISTA, blacklist: ESTRATEGISTA },
  giveaway: { criar: ESTRATEGISTA, encerrar: ESTRATEGISTA, reroll: ESTRATEGISTA },
  leaderboard: { atualizar: STAFF },
});

/** O nível exigido por um comando de barra, já com o subcomando resolvido. */
export function commandLevel(interaction) {
  const regra = COMMAND_ACCESS[interaction.commandName];
  if (!regra) return TODOS;
  if (typeof regra === 'string') return regra;
  if (typeof regra === 'function') return regra(interaction);
  const chave = interaction.options.getSubcommandGroup(false) ?? interaction.options.getSubcommand(false);
  return regra[chave] ?? TODOS;
}

/** Só para teste: a tabela inteira. */
export const COMMAND_ACCESS_TABLE = COMMAND_ACCESS;
