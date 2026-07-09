import { collections } from '../db/mongo.js';

export const CHANNEL_KEYS = [
  'registration',
  'blacklist', // único canal visível para quem tem o cargo de banido
  'applications',
  'recruiters',
  'war',
  'tome',
  'loans',
  'logs',
  'panel', // painel ao vivo da guilda
  'activity', // ruído: online/offline, servidor, XP, nível, season
  'raids', // guild raids concluídas (cai em activity se não configurado)
  'territory', // atualizações de território
  'errors', // erros do bot
];

export const ROLE_KEYS = [
  'community',
  'guildMember', // cargo único automático para quem está na guilda
  'neutral', // registrado, mas fora da nossa guilda e da black-list
  'banned', // registrado e pertencente à guilda da black-list
  'topContributor', // cargo automático para os top N em pontos
  'war',
  'mainWar',
  'recruiters',
  // Cargos de rank abaixo: NÃO são atribuídos automaticamente (gestão manual).
  'owner',
  'chief',
  'strategist',
  'captain',
  'recruiter',
  'recruit',
];

export const PARAM_KEYS = [
  'voteWindowHours',
  'voteRule',
  'roleSyncMinutes',
  'pointsWeights',
  'reapplyCooldownHours',
  'snapshotHourUTC',
  'loanReminderHourUTC',
  'watcherSeconds',
  'inactivityDays',
  'topContributorCount',
  'verifyHourUTC',
  'territoryMultiplierCap',
  'seasonMode',
  'voterRoles',
  'announcePresence',
];

const DEFAULT_PARAMS = {
  voteWindowHours: 24,
  voteRule: 'effective', // 'effective' | 'total' (ver design.md §6)
  roleSyncMinutes: 10,
  // Multiplicadores do sistema de pontos unificado (design.md §17).
  // territoryBase é o valor de uma captura ANTES do multiplicador de fronteiras.
  pointsWeights: { war: 10, raid: 5, guildRaid: 15, weekly: 20, contribPerMillion: 1, territoryBase: 20 },
  // Teto do multiplicador de captura. O HQ de uma guilda grande chega a x25 pela
  // fórmula do jogo, o que sozinho dominaria o ranking.
  territoryMultiplierCap: 8,
  // 'wynn': a season do bot acompanha a do jogo (S31, depois OFF-31, depois S32).
  // 'manual': só muda com /season start.
  seasonMode: 'wynn',
  // Cargos do Discord que podem votar nas candidaturas. Vazio = cai no rank do
  // jogo (Owner + Chief), que é o comportamento antigo.
  voterRoles: [],
  // Online/offline e troca de servidor de cada membro. Com 50+ membros isso são
  // centenas de mensagens por dia; XP, nível, guerras e season não são afetados.
  announcePresence: true,
  reapplyCooldownHours: 48,
  snapshotHourUTC: 5, // horário (UTC) do snapshot diário de progresso
  loanReminderHourUTC: 12,
  watcherSeconds: 60, // frequência do poller de monitoramento
  inactivityDays: 7, // limite para marcar membro como inativo
  topContributorCount: 3, // nº de "Top Contribuidores"
  verifyHourUTC: 12, // horário (UTC) do relatório automático de verificação
};

const cache = new Map(); // guildDiscordId -> doc

export async function getConfig(guildDiscordId) {
  if (cache.has(guildDiscordId)) return cache.get(guildDiscordId);
  let doc = await collections.config().findOne({ guildDiscordId });
  if (!doc) {
    doc = {
      guildDiscordId,
      channels: {},
      roles: {},
      params: { ...DEFAULT_PARAMS },
    };
    await collections.config().insertOne(doc);
  }
  doc.params = { ...DEFAULT_PARAMS, ...(doc.params || {}) };
  cache.set(guildDiscordId, doc);
  return doc;
}

export async function setChannel(guildDiscordId, key, channelId) {
  await collections
    .config()
    .updateOne(
      { guildDiscordId },
      { $set: { [`channels.${key}`]: channelId } },
      { upsert: true },
    );
  cache.delete(guildDiscordId);
}

export async function setRole(guildDiscordId, key, roleId) {
  await collections
    .config()
    .updateOne(
      { guildDiscordId },
      { $set: { [`roles.${key}`]: roleId } },
      { upsert: true },
    );
  cache.delete(guildDiscordId);
}

export async function setParam(guildDiscordId, key, value) {
  await collections
    .config()
    .updateOne(
      { guildDiscordId },
      { $set: { [`params.${key}`]: value } },
      { upsert: true },
    );
  cache.delete(guildDiscordId);
}
