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
  'recruiters', // painel de recrutamento e anúncio de recruta aprovado
  'recruitAlerts', // privado: avisa a staff quando um neutro se registra
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
  'weeklyStreakBonusPerWeek',
  'weeklyStreakBonusMax',
  'seasonMode',
  'voterRoles',
  'announcePresence',
  'reapplyCooldownHours',
  'snapshotHourUTC',
  'loanReminderHourUTC',
  'watcherSeconds',
  'inactivityDays',
  'inactivityForgivenessPerPoints',
  'inactivityForgivenessMaxDays',
  'verifyHourUTC',
]);

/**
 * Multiplicadores do sistema de pontos unificado. Nenhum evento guarda pontos:
 * o valor é sempre derivado destes pesos na hora de somar, então mudar um deles
 * reescreve todo o histórico (ver services/points.js).
 *
 * Tabela oficial:
 *   1.000.000 de Guild XP  →  1 ponto
 *   1 guild raid           →  10 pontos, para cada membro do grupo
 *   1 guerra               →  10 pontos × multiplicador de conexões/externals
 *   1 objetivo semanal     →  30 pontos × (1 + 10% por semana seguida, teto +100%)
 *
 * @typedef {object} PointsWeights
 * @property {number} war                base de uma guerra
 * @property {number} raid               raid comum (fora de guilda); 0 = não pontua
 * @property {number} guildRaid          por membro do grupo
 * @property {number} weekly             base de um objetivo semanal
 * @property {number} contribPerMillion  pontos por 1.000.000 de Guild XP
 * @property {number} territoryBase      base sobre a qual incide o multiplicador da captura
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
 * @property {number}         inactivityDays        limite BASE de dias offline
 * @property {number}         inactivityForgivenessPerPoints  pontos que compram +1 dia
 * @property {number}         inactivityForgivenessMaxDays    teto de dias de perdão
 * @property {number}         verifyHourUTC         hora do relatório de verificação
 */

/** @type {GuildParams} */
const DEFAULT_PARAMS = Object.freeze({
  voteWindowHours: 24,
  voteRule: 'effective',
  roleSyncMinutes: 10,
  pointsWeights: Object.freeze({
    war: 10,
    raid: 0, // raid comum não entra na tabela de pontuação
    guildRaid: 10,
    weekly: 30,
    contribPerMillion: 1,
    // Igual ao peso da guerra de propósito: o evento de território paga só o
    // EXCEDENTE do multiplicador, e a soma fecha em `war × multiplicador`.
    territoryBase: 10,
  }),
  // O QG de uma guilda grande chega a x25 pela fórmula do jogo, o que sozinho
  // dominaria o ranking.
  territoryMultiplierCap: 8,
  // Objetivo semanal: +10% por semana consecutiva, acumulando no máximo +100%.
  weeklyStreakBonusPerWeek: 0.1,
  weeklyStreakBonusMax: 1,
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
  // Limite base de dias offline antes de o membro poder ser expulso.
  inactivityDays: 7,
  // Cada 1000 pontos compram +1 dia de perdão. Guerras, guild raids e objetivos
  // semanais rendem margem tanto quanto o Guild XP.
  inactivityForgivenessPerPoints: 1000,
  inactivityForgivenessMaxDays: 30,
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

/** @param {unknown} v @returns {boolean} objeto simples (não array, não null) */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Mescla os parâmetros salvos sobre os padrões, UM NÍVEL PARA DENTRO.
 *
 * Um merge raso seria um bug silencioso: o documento no banco foi gravado quando
 * `pointsWeights` só tinha três chaves, e substituiria o objeto inteiro. As
 * chaves novas (guildRaid, weekly, territoryBase) virariam `undefined`, e como
 * `eventPoints` faz `peso || 0`, guild raids e objetivos semanais passariam a
 * valer ZERO sem ninguém notar.
 *
 * Arrays são substituídos, não mesclados — `voterRoles: []` precisa poder zerar.
 *
 * @param {Partial<GuildParams>} stored
 * @returns {GuildParams}
 */
function mergeParams(stored = {}) {
  const out = { ...DEFAULT_PARAMS };
  for (const [key, value] of Object.entries(stored)) {
    const fallback = DEFAULT_PARAMS[key];
    out[key] =
      isPlainObject(fallback) && isPlainObject(value) ? { ...fallback, ...value } : value;
  }
  return out;
}

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
  // Parâmetros novos entram com o padrão sem precisar de migração — inclusive os
  // aninhados, como pointsWeights.
  doc.params = mergeParams(doc.params);
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
