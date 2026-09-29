import { collections } from '../db/mongo.js';
import { brDateTime } from '../util/format.js';

// Histórico de entregas de recompensa (Tomes, aspects e esmeraldas).
//
// Antes disto, cada entrega virava uma MENSAGEM no canal, apagada 24h depois: o
// canal virava um mural de avisos repetidos e, passado um dia, não sobrava
// registro nenhum de quem recebeu o quê. Agora a entrega é uma LINHA, e cada
// painel do canal mostra as últimas do próprio tipo.

/** Entregas mostradas em cada painel. */
export const LOG_SIZE = 10;

/**
 * Registra uma entrega no histórico.
 *
 * `amount` é sempre em UNIDADES DE ENTREGA: 1 Tome, 1 aspect, ou 1 lote de
 * esmeraldas (1.024 Es). É o número que a staff digitou, e é o que o log mostra.
 *
 * @param {{kind:'tome'|'aspect'|'emerald', uuid:string, username:string, discordId?:string|null, amount?:number, byDiscordId:string}} p
 */
export async function recordDelivery({ kind, uuid, username, discordId = null, amount = 1, byDiscordId }) {
  await collections.rewardLog().insertOne({
    at: new Date(),
    kind,
    uuid,
    username,
    discordId,
    amount,
    byDiscordId,
  });
}

/**
 * As últimas entregas de UM tipo, da mais recente para a mais antiga.
 *
 * O `_id` desempata: duas entregas no mesmo milissegundo empatam no `at`, e o
 * Mongo não promete ordem entre empates — o painel mostraria as duas em ordem
 * arbitrária, trocando de posição a cada atualização. ObjectId é monotônico,
 * então ele resolve o empate na ordem real de inserção.
 *
 * @param {'tome'|'aspect'|'emerald'} kind
 */
export async function recentDeliveries(kind, limit = LOG_SIZE) {
  return collections.rewardLog().find({ kind }).sort({ at: -1, _id: -1 }).limit(limit).toArray();
}

/**
 * Junta as linhas respeitando o teto de 1024 do campo de embed, cortando por
 * LINHA inteira. Estourar o limite faz a edição do painel falhar por completo —
 * o painel congela e só o log denuncia.
 */
export function fieldValue(linhas, max = 1024) {
  const out = [];
  let tamanho = 0;
  for (const linha of linhas) {
    if (tamanho + linha.length + 1 > max) break;
    out.push(linha);
    tamanho += linha.length + 1;
  }
  return out.join('\n');
}

/**
 * O campo "Últimas entregas" de um painel.
 *
 * O horário vai sem o "(UTC-3)" do brDateTime: são dez linhas seguidas, e o
 * rodapé do painel já diz que é horário de Brasília.
 *
 * @param {'tome'|'aspect'|'emerald'} kind
 * @param {(d: object) => string} oque  descreve o que saiu naquela entrega
 */
export async function deliveryLogField(kind, oque) {
  const linhas = (await recentDeliveries(kind)).map((d) => {
    const quem = d.discordId ? `<@${d.discordId}>` : `**${d.username}**`;
    return `\`${brDateTime(d.at).replace(' (UTC-3)', '')}\` ${oque(d)} → ${quem} · por <@${d.byDiscordId}>`;
  });
  return {
    name: `🧾 Últimas ${LOG_SIZE} entregas`,
    value: fieldValue(linhas) || 'Nenhuma entrega registrada ainda.',
  };
}
