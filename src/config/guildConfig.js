import { collections } from '../db/mongo.js';

/**
 * Configuração por servidor do Discord, persistida na coleção `config`.
 * Tudo aqui é editável em runtime pelo comando /config, sem redeploy.
 */

/**
 * Chaves de canal aceitas por `/config channel`.
 * @type {readonly string[]}
 */
export const CHANNEL_KEYS = Object.freeze([
  'registration', // painel de verificação; mensagens de membro são apagadas
  'blacklist', // único canal visível para quem tem o cargo de banido
  'applications', // votação de candidatura (público, voto anônimo)
  'recruiters', // painel de recrutamento e aviso de novo registro neutro
  'war', // convocação de guerra e alerta de território
  'warApplication', // painel de como pedir cargo WAR / MAIN WAR
  'tome', // painel e fila de tomes
  'loans', // painel de empréstimos e lembretes de vencimento
  'rules', // painel de regras
  'pings', // painel de auto-role; mensagens de membro são apagadas em 48h
  'logs', // auditoria das ações do bot
  'panel', // painel ao vivo da guilda + painel de leaderboards
  'activity', // online/offline, servidor, XP, nível, season
  'raids', // guild raids e objetivos semanais (cai em activity se ausente)
  'territory', // detalhe de captura/perda de território
  'errors', // exceções do bot
]);

/**
 * Chaves de cargo aceitas por `/config role`. O bot só aplica estes.
 *
 * Os ranks da guilda (Líder, Sub-líder, Estrategista, Capitão, Recrutador,
 * Recruta) NÃO estão aqui de propósito: eles derivam de um nick que ninguém
 * verificou, e são gestão manual da staff.
 * @type {readonly string[]}
 */
export const ROLE_KEYS = Object.freeze([
  'community', // todo mundo que se registrou e não está banido
  'guildMember', // quem está na guilda; recebe `community` junto
  'banned', // pertence à guilda da black-list, ou foi banido pela staff
  'war', // pingado na convocação de guerra
  'mainWar', // pode disparar /war
]);

/**
 * Chaves de parâmetro aceitas por `/config param`.
 * @type {readonly string[]}
 */
export const PARAM_KEYS = Object.freeze([
  'voteWindowHours',
  'voteRule',
  'roleSyncMinutes',
  'pointsWeights',
  'territoryMultiplierCap',
  'seasonMode',
  'voterRoles',
  'announcePresence',
  'reapplyCooldownHours',
  'snapshotHourUTC',
  'loanReminderHourUTC',
  'watcherSeconds',
  'inactivityDays',
  'verifyHourUTC',
]);

/**
 * Multiplicadores do sistema de pontos unificado. Nenhum evento guarda pontos:
 * o valor é sempre derivado destes pesos na hora de somar, então mudar um deles
 * reescreve todo o histórico (ver services/points.js).
 * @typedef {object} PointsWeights
 * @property {number} war                pontos por guerra
 * @property {number} raid               pontos por raid comum
 * @property {number} guildRaid          pontos por guild raid
 * @property {number} weekly             pontos por objetivo semanal concluído
 * @property {number} contribPerMillion  pontos por 1.000.000 de Guild XP
 * @property {number} territoryBase      valor de uma captura ANTES do multiplicador de fronteiras
 */

/**
 * @typedef {object} GuildParams
 * @property {number}         voteWindowHours       prazo da votação de candidatura
 * @property {'effective'|'total'} voteRule         'effective' ignora abstenções
 * @property {number}         roleSyncMinutes       frequência do sync de cargos
 * @property {PointsWeights}  pointsWeights
 * @property {number}         territoryMultiplierCap teto do multiplicador de captura
 * @property {'wynn'|'manual'} seasonMode           'wynn' acompanha a season do jogo
 * @property {string[]}       voterRoles            cargos do Discord que podem votar
 * @property {boolean}        announcePresence      anunciar online/offline e troca de mundo
 * @property {number}         reapplyCooldownHours  espera após reprovação
 * @property {number}         snapshotHourUTC       hora da apuração diária
 * @property {number}         loanReminderHourUTC   hora dos lembretes de empréstimo
 * @property {number}         watcherSeconds        frequência do poller
 * @property {number}         inactivityDays        limite para marcar inativo
 * @property {number}         verifyHourUTC         hora do relatório de verificação
 */

/** @type {GuildParams} */
const DEFAULT_PARAMS = Object.freeze({
  voteWindowHours: 24,
  voteRule: 'effective',
  roleSyncMinutes: 10,
  pointsWeights: Object.freeze({
    war: 10,
    raid: 5,
    guildRaid: 15,
    weekly: 20,
    contribPerMillion: 1,
    territoryBase: 20,
  }),
  // O QG de uma guilda grande chega a x25 pela fórmula do jogo, o que sozinho
  // dominaria o ranking.
  territoryMultiplierCap: 8,
  seasonMode: 'wynn',
  // Vazio = cai no rank do jogo (Owner + Chief), o comportamento antigo.
  voterRoles: Object.freeze([]),
  // Com 50+ membros isso são centenas de mensagens por dia. XP, nível, guerras e
  // season continuam sendo anunciados de qualquer forma.
  announcePresence: true,
  reapplyCooldownHours: 48,
  snapshotHourUTC: 5,
  loanReminderHourUTC: 12,
  watcherSeconds: 60,
  inactivityDays: 7,
  verifyHourUTC: 12,
});

/**
 * @typedef {object} GuildConfig
 * @property {string} guildDiscordId
 * @property {Record<string, string>} channels  chave de CHANNEL_KEYS -> id do canal
 * @property {Record<string, string>} roles     chave de ROLE_KEYS -> id do cargo
 * @property {GuildParams} params
 */

/**
 * Cache em memória: a config é lida em quase todo evento do bot.
 * Invalidado por qualquer setter abaixo.
 * @type {Map<string, GuildConfig>}
 */
const cache = new Map();

/**
 * @param {string} guildDiscordId
 * @returns {Promise<GuildConfig>}
 */
export async function getConfig(guildDiscordId) {
  const cached = cache.get(guildDiscordId);
  if (cached) return cached;

  let doc = await collections.config().findOne({ guildDiscordId });
  if (!doc) {
    doc = { guildDiscordId, channels: {}, roles: {}, params: { ...DEFAULT_PARAMS } };
    await collections.config().insertOne(doc);
  }
  // Parâmetros novos entram com o padrão sem precisar de migração.
  doc.params = { ...DEFAULT_PARAMS, ...(doc.params || {}) };
  cache.set(guildDiscordId, doc);
  return doc;
}

/**
 * @param {string} guildDiscordId
 * @param {string} field  'channels' | 'roles' | 'params'
 * @param {string} key
 * @param {unknown} value
 */
async function setField(guildDiscordId, field, key, value) {
  await collections
    .config()
    .updateOne({ guildDiscordId }, { $set: { [`${field}.${key}`]: value } }, { upsert: true });
  cache.delete(guildDiscordId);
}

/** @param {string} guildDiscordId @param {string} key @param {string} channelId */
export function setChannel(guildDiscordId, key, channelId) {
  return setField(guildDiscordId, 'channels', key, channelId);
}

/** @param {string} guildDiscordId @param {string} key @param {string} roleId */
export function setRole(guildDiscordId, key, roleId) {
  return setField(guildDiscordId, 'roles', key, roleId);
}

/** @param {string} guildDiscordId @param {string} key @param {unknown} value */
export function setParam(guildDiscordId, key, value) {
  return setField(guildDiscordId, 'params', key, value);
}
