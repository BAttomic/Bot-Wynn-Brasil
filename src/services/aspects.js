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
//   pendente      = gerado − entregue     (PODE SER NEGATIVO, de propósito)
//
// O pendente negativo é a correção de erro de digitação embutida na conta. Quem
// entregou 20 onde eram 2 fica com −18: a pessoa parou de aparecer na lista de
// entrega (o filtro é `pending > 0`) e as próximas 36 raids dela apenas quitam
// o excedente antes de voltar a gerar aspect. Com o antigo `max(0, …)` o erro
// sumia de vista e virava presente permanente, sem ninguém saber que houve.

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

/** Campos de `guildStats` que a conta de aspects precisa. */
const ASPECT_PROJECTION = {
  uuid: 1,
  username: 1,
  guildRaids: 1,
  aspectBaseRaids: 1,
  aspectsDelivered: 1,
  joinedGuildAt: 1,
};

/**
 * A conta de um membro só. Fica isolada para `listAspects` e o resumo de uma
 * pessoa (usado na mensagem de entrega) nunca poderem divergir.
 *
 * `pending` é o SALDO, e continua fracionário: a 0,5 por raid, um número ímpar
 * de raids deixa meio aspect pendurado. `deliverable` é quanto dá para entregar
 * DE VERDADE — aspect no jogo é item inteiro, não existe passar meio. A metade
 * que sobra não se perde: fica no saldo e vira unidade quando a próxima raid
 * fechar o par.
 */
function computeAspect(r, rate, minDays) {
  // Sem baseline ainda → base = total atual → 0 raids contados (começa do zero).
  const base = r.aspectBaseRaids ?? r.guildRaids ?? 0;
  const raids = Math.max(0, (r.guildRaids ?? 0) - base);
  const earned = raids * rate;
  const delivered = r.aspectsDelivered ?? 0;
  const pending = earned - delivered;
  const days = r.joinedGuildAt ? Math.floor((Date.now() - new Date(r.joinedGuildAt).getTime()) / 86_400_000) : null;
  return {
    uuid: r.uuid,
    username: r.username,
    raids,
    earned,
    delivered,
    pending,
    // Saldo negativo (entregou-se a mais no passado) não vira dívida a entregar.
    deliverable: Math.max(0, Math.floor(pending)),
    days,
    eligible: days !== null && days >= minDays,
  };
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
    .find({ guildRaids: { $gt: 0 } }, { projection: ASPECT_PROJECTION })
    .toArray();

  return rows.map((r) => computeAspect(r, rate, minDays));
}

/**
 * O mesmo retrato, para UMA pessoa. Existe para a mensagem de entrega poder
 * dizer o acumulado sem varrer a coleção inteira.
 * @returns {Promise<ReturnType<typeof computeAspect>|null>}
 */
export async function aspectStatus(guildId, uuid) {
  const { params } = await getConfig(guildId);
  const rate = Number(params?.aspectsPerGuildRaid) || 0.5;
  const minDays = Number(params?.rewardMinGuildDays) || 7;
  const row = await collections.guildStats().findOne({ uuid }, { projection: ASPECT_PROJECTION });
  return row ? computeAspect(row, rate, minDays) : null;
}

/**
 * Só quem PODE receber agora: elegível e com pelo menos UMA unidade inteira.
 *
 * Quem tem só 0,5 acumulado fica de fora — não há o que entregar, e listar essa
 * pessoa no menu seria oferecer uma entrega impossível. Ela continua aparecendo
 * no `/aspects`, onde o saldo fracionário é informação legítima.
 */
export async function pendingAspects(guildId) {
  return (await listAspects(guildId))
    .filter((a) => a.eligible && a.deliverable >= 1)
    .sort((a, b) => b.deliverable - a.deliverable);
}

/**
 * Registra uma entrega (acumula em guildStats.aspectsDelivered).
 *
 * Só aceita unidade inteira: aspect é item, e meio item não passa de mão. Entregar
 * MAIS do que o saldo é permitido de propósito — acontece de a staff passar a
 * mais no jogo, e o excedente vira saldo negativo que as próximas raids quitam.
 *
 * @returns {boolean} false se a quantidade não for um inteiro positivo
 */
export async function deliverAspects(uuid, amount) {
  if (!Number.isInteger(amount) || amount <= 0) return false;
  await collections.guildStats().updateOne({ uuid }, { $inc: { aspectsDelivered: amount } });
  return true;
}

/**
 * Estorna (ou soma) aspects sobre o total já entregue.
 *
 * É a forma direta de desfazer uma entrega digitada errada: "passei 18 a mais"
 * vira `-18`, sem precisar saber o acumulado da pessoa. `setAspectsDelivered`
 * continua existindo para quando se sabe o total certo, mas exigir o acumulado
 * é pedir uma consulta antes de cada correção — e o erro que estamos
 * consertando nasceu justamente de uma conta feita às pressas.
 *
 * O total nunca fica negativo: entregue é "quanto saiu do baú", e isso não
 * pode ser menos que zero. Quem fica negativo é o SALDO (gerado − entregue),
 * calculado em listAspects.
 *
 * Só unidades inteiras: o que se corrige aqui é quanto SAIU do baú, e do baú
 * nunca saiu meio aspect. Um ajuste fracionário só poderia vir de erro de
 * digitação, e aceitá-lo criaria um saldo quebrado que nunca fecha.
 *
 * @param {string} uuid
 * @param {number} delta  inteiro; positivo soma, negativo estorna
 * @returns {Promise<{antes:number, agora:number}|null>} null se não achou
 */
export async function adjustAspectsDelivered(uuid, delta) {
  if (!Number.isInteger(delta) || delta === 0) return null;
  const antes = await collections.guildStats().findOne({ uuid }, { projection: { aspectsDelivered: 1 } });
  if (!antes) return null;
  const agora = Math.max(0, (antes.aspectsDelivered ?? 0) + delta);
  await collections.guildStats().updateOne({ uuid }, { $set: { aspectsDelivered: agora } });
  return { antes: antes.aspectsDelivered ?? 0, agora };
}

/**
 * Corrige o total já entregue a alguém, para o caso de a staff ter digitado o
 * número errado no modal de entrega.
 *
 * É um SET, não um $inc, e isso é deliberado: quem está corrigindo sabe quanto
 * a pessoa recebeu de verdade, não quanto errou. "Entreguei 2, não 20" é
 * direto; "subtraia 18" exige fazer a conta de cabeça e erra de novo.
 *
 * Não mexe em `aspectBaseRaids` — o gerado continua saindo das raids reais.
 * Se o novo total passar do gerado, o pendente fica negativo, e as próximas
 * raids quitam a diferença antes de voltar a render aspect.
 *
 * @param {string} uuid
 * @param {number} total  novo valor de aspectsDelivered (>= 0)
 * @returns {Promise<{antes:number, agora:number}|null>} null se não achou
 */
export async function setAspectsDelivered(uuid, total) {
  if (!(total >= 0)) return null;
  const antes = await collections
    .guildStats()
    .findOneAndUpdate(
      { uuid },
      { $set: { aspectsDelivered: total } },
      { returnDocument: 'before', projection: { aspectsDelivered: 1 } },
    );
  if (!antes) return null;
  return { antes: antes.aspectsDelivered ?? 0, agora: total };
}
