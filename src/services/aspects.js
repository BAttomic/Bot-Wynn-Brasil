import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';

// Aspects são recompensa de guild raid, entregues como os tomes. Nada é gravado
// como "gerado": o total sai do contador de raids (currentGuildRaids, já escopado
// à guilda pela API) × o rate. O que se acumula é só o ENTREGUE
// (guildStats.aspectsDelivered), e o pendente é a diferença.
//
//   gerado   = aspectsPerGuildRaid × guildRaids
//   entregue = guildStats.aspectsDelivered
//   pendente = max(0, gerado − entregue)

export async function getAspectRate(guildId) {
  const { params } = await getConfig(guildId);
  return Number(params?.aspectsPerGuildRaid) || 0.5;
}

/**
 * Todos os membros que já geraram algum aspect, com gerado/entregue/pendente.
 * @returns {Promise<Array<{uuid:string, username:string, raids:number, earned:number, delivered:number, pending:number}>>}
 */
export async function listAspects(guildId) {
  const rate = await getAspectRate(guildId);
  const rows = await collections
    .guildStats()
    .find({ guildRaids: { $gt: 0 } }, { projection: { uuid: 1, username: 1, guildRaids: 1, aspectsDelivered: 1 } })
    .toArray();

  return rows.map((r) => {
    const raids = r.guildRaids ?? 0;
    const earned = raids * rate;
    const delivered = r.aspectsDelivered ?? 0;
    return { uuid: r.uuid, username: r.username, raids, earned, delivered, pending: Math.max(0, earned - delivered) };
  });
}

/** Só quem tem aspect a receber, do maior pendente para o menor. */
export async function pendingAspects(guildId) {
  return (await listAspects(guildId)).filter((a) => a.pending > 0).sort((a, b) => b.pending - a.pending);
}

/** Registra uma entrega (acumula em guildStats.aspectsDelivered). */
export async function deliverAspects(uuid, amount) {
  if (!(amount > 0)) return false;
  await collections.guildStats().updateOne({ uuid }, { $inc: { aspectsDelivered: amount } });
  return true;
}
