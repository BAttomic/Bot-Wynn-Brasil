import { collections } from '../db/mongo.js';

// A prioridade da fila de Tomes usa o sistema de pontos unificado (design.md §17):
// quem tem mais pontos (guerras + raids + contribuição + eventos) vem primeiro.
export async function rankedQueue() {
  const queue = await collections.tomeQueue().find({}).toArray();
  if (!queue.length) return [];
  const uuids = queue.map((q) => q.uuid);
  const stats = await collections.guildStats().find({ uuid: { $in: uuids } }).toArray();
  const byUuid = new Map(stats.map((s) => [s.uuid, s]));
  return queue
    .map((q) => ({ ...q, points: byUuid.get(q.uuid)?.points ?? 0 }))
    .sort((a, b) => b.points - a.points);
}
