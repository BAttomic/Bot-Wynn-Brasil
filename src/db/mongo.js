import { MongoClient } from 'mongodb';
import { required, optional } from '../config/env.js';
import { log } from '../util/log.js';

let client;
let db;

export async function connectMongo() {
  const uri = required('MONGO_URI');
  const dbName = optional('MONGO_DB', 'wynn_guild');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);
  await ensureIndexes();
  log.info(`MongoDB conectado (db: ${dbName})`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('MongoDB não conectado ainda');
  return db;
}

export const collections = {
  members: () => getDb().collection('members'),
  applications: () => getDb().collection('applications'),
  progressSnapshots: () => getDb().collection('progressSnapshots'),
  guildStats: () => getDb().collection('guildStats'),
  seasons: () => getDb().collection('seasons'),
  seasonParticipation: () => getDb().collection('seasonParticipation'),
  tomeQueue: () => getDb().collection('tomeQueue'),
  loans: () => getDb().collection('loans'),
  warCalls: () => getDb().collection('warCalls'),
  watcherState: () => getDb().collection('watcherState'),
  config: () => getDb().collection('config'),
};

async function ensureIndexes() {
  await collections.members().createIndex({ uuid: 1 }, { unique: true });
  await collections.members().createIndex({ discordId: 1 }, { unique: true });
  await collections.progressSnapshots().createIndex({ uuid: 1, takenAt: -1 });
  await collections.guildStats().createIndex({ uuid: 1 }, { unique: true });
  await collections
    .seasonParticipation()
    .createIndex({ seasonId: 1, uuid: 1 }, { unique: true });
  await collections.seasons().createIndex({ active: 1 });
  await collections.tomeQueue().createIndex({ uuid: 1 }, { unique: true });
  await collections.loans().createIndex({ borrowerDiscordId: 1, status: 1 });
  await collections.warCalls().createIndex({ messageId: 1 }, { unique: true });
  await collections.config().createIndex({ guildDiscordId: 1 }, { unique: true });
}

export async function closeMongo() {
  if (client) await client.close();
}
