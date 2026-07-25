import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';

// Aspects são recompensa de guild raid, entregues como os tomes. A contagem
// começa do ZERO: cada membro tem uma BASELINE (o valor de guildRaids quando o
// sistema entrou), e só os raids DAQUI PRA FRENTE geram aspect. Nada é gravado
// como "gerado" — é sempre derivado. O que se acumula é só o ENTREGUE.
//
//   raids desde 0 = max(0, guildRaids − aspectBaseRaids)
//   gerado        = aspectsPerGuildRaid × (raids desde 0)
//   entregue      = guildStats.aspectsDelivered
//   pendente      = max(0, gerado − entregue)

export async function getAspectRate(guildId) {
  const { params } = await getConfig(guildId);
  return Number(params?.aspectsPerGuildRaid) || 0.5;
}

/**
 * Fixa a baseline de quem ainda não tem: todo mundo passa a contar do zero a
 * partir do guildRaids atual. Idempotente — só toca em quem falta. Roda no boot
 * e é reforçada pelo $setOnInsert do snapshot para membros novos.
 */
export async function ensureAspectBaselines() {
  await collections.guildStats().updateMany(
    { aspectBaseRaids: { $exists: false } },
    [{ $set: { aspectBaseRaids: { $ifNull: ['$guildRaids', 0] } } }],
  );
}

/**
 * Todos os membros com guild raids, contados do 0, já com elegibilidade dos 7
 * dias na guilda (só elegíveis podem RECEBER; os demais acumulam e esperam).
 * @returns {Promise<Array<{uuid:string, username:string, raids:number, earned:number, delivered:number, pending:number, days:number|null, eligible:boolean}>>}
 */
export async function listAspects(guildId) {
  const { params } = await getConfig(guildId);
  const rate = Number(params?.aspectsPerGuildRaid) || 0.5;
  const minDays = Number(params?.rewardMinGuildDays) || 7;

  const rows = await collections
    .guildStats()
    .find(
      { guildRaids: { $gt: 0 } },
      { projection: { uuid: 1, username: 1, guildRaids: 1, aspectBaseRaids: 1, aspectsDelivered: 1, joinedGuildAt: 1 } },
    )
    .toArray();

  return rows.map((r) => {
    // Sem baseline ainda → base = total atual → 0 raids contados (começa do zero).
    const base = r.aspectBaseRaids ?? r.guildRaids ?? 0;
    const raids = Math.max(0, (r.guildRaids ?? 0) - base);
    const earned = raids * rate;
    const delivered = r.aspectsDelivered ?? 0;
    const days = r.joinedGuildAt ? Math.floor((Date.now() - new Date(r.joinedGuildAt).getTime()) / 86_400_000) : null;
    return {
      uuid: r.uuid,
      username: r.username,
      raids,
      earned,
      delivered,
      pending: Math.max(0, earned - delivered),
      days,
      eligible: days !== null && days >= minDays,
    };
  });
}

/** Só quem PODE receber agora (elegível + com pendência), do maior para o menor. */
export async function pendingAspects(guildId) {
  return (await listAspects(guildId))
    .filter((a) => a.eligible && a.pending > 0)
    .sort((a, b) => b.pending - a.pending);
}

/** Registra uma entrega (acumula em guildStats.aspectsDelivered). */
export async function deliverAspects(uuid, amount) {
  if (!(amount > 0)) return false;
  await collections.guildStats().updateOne({ uuid }, { $inc: { aspectsDelivered: amount } });
  return true;
}
