import { collections } from '../db/mongo.js';
import { getConfig } from '../config/guildConfig.js';
import { awardPoints } from './points.js';
import { shortNumber } from '../util/format.js';
import { log } from '../util/log.js';

// Eventos de competição por métrica.
//
// A apuração NÃO tem contador próprio: ela lê o livro-razão `pointsEvents`, que
// já registra quantidade bruta com data (ver services/points.js). Um evento é só
// uma JANELA sobre esse livro — logo, criar um evento com data retroativa
// funciona, reprocessar não duplica nada, e apagar o evento não perde histórico.
//
// `eventScores` é a tabela secundária pedida: cache materializado do ranking,
// recomputável a qualquer momento a partir do livro-razão.

const MEDALS = ['🥇', '🥈', '🥉'];

/** Medalha do lugar, ou `4º`, `5º`… daí para baixo. @param {number} rank 1-based */
export function placeLabel(rank) {
  return MEDALS[rank - 1] ?? `${rank}º`;
}

/**
 * O Discord não deixa digitar Enter num campo de slash command: o texto chega
 * sempre numa linha só. Então a staff escreve `\n` onde quer a quebra e a gente
 * converte aqui. Aceita `\n` literal e `\\n` (o que sai de um copiar-e-colar).
 * @param {string} [text]
 * @returns {string}
 */
export function multiline(text) {
  return String(text ?? '')
    .replace(/\\{1,2}n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Unidades de esmeralda escritas por extenso — `2 Stx` vira `2 STX`, para o
// painel sair uniforme independente de como a staff digitou.
const EMERALD_UNITS = /\b(stx|le|eb|em)\b/gi;

/**
 * A recompensa é uma lista separada por VÍRGULA, uma entrada por premiado, na
 * ordem do pódio: `Idol, 2 Stx, 1 Stx` → 1º leva Idol, 2º leva 2 STX, 3º leva
 * 1 STX. Sem vírgula, é uma recompensa só (todo evento antigo cai aqui).
 * @param {string} [prize]
 * @returns {string[]}
 */
export function parsePrizes(prize) {
  return String(prize ?? '')
    .split(',')
    .map((p) => p.trim().replace(EMERALD_UNITS, (u) => u.toUpperCase()))
    .filter(Boolean);
}

/**
 * Uma linha por premiado, com a medalha do lugar.
 *
 * `podium` corta a lista: a criação já recusa mais recompensas que premiados,
 * mas um evento ANTIGO pode ter vírgula no meio de uma recompensa só ("3 LE,
 * cargo de Campeão") — sem o corte, ele ganharia um 🥈 que não existe.
 *
 * @param {string} [prize]   texto cru, como veio do comando
 * @param {number} [podium]  quantos colocados são premiados
 * @returns {string} já pronto para o embed
 */
export function renderPrizes(prize, podium = 0) {
  let prizes = parsePrizes(prize);
  if (podium > 0 && prizes.length > podium) {
    // Junta o excedente de volta na última linha, em vez de perder texto.
    prizes = [...prizes.slice(0, podium - 1), prizes.slice(podium - 1).join(', ')];
  }
  if (!prizes.length) return '—';
  return prizes.map((p, i) => `${placeLabel(i + 1)} ${p}`).join('\n');
}

/**
 * Métricas disputáveis.
 *
 * `live` marca a métrica que tem GATILHO PRÓPRIO: o watcher (poller de 60s) já
 * detecta cada guild raid no instante em que ela termina, então o evento é
 * creditado ali mesmo, e não na apuração do dia seguinte. Guerra e XP não têm
 * gatilho — só existem como delta da contagem diária —, e para essas o evento
 * lê a janela do livro-razão (`type`).
 *
 * @typedef {object} Metric
 * @property {string}  label
 * @property {string}  emoji
 * @property {string}  unit
 * @property {string}  type    tipo em pointsEvents (usado quando não é `live`)
 * @property {boolean} [live]  creditada pelo gatilho, no instante do fato
 * @property {boolean} [short] abreviar números grandes (ex.: 50M)
 * @type {Readonly<Record<string, Metric>>}
 */
export const METRICS = Object.freeze({
  guildraid: { label: 'Guild Raids', emoji: '🛡️', unit: 'guild raids', type: 'guildRaid', live: true },
  guerra: { label: 'Guerras', emoji: '⚔️', unit: 'guerras', type: 'war' },
  xp: { label: 'XP contribuído', emoji: '📈', unit: 'XP', type: 'contribution', short: true },
});

/** Fuso em que a staff pensa as datas. O Brasil não tem mais horário de verão. */
export const TIMEZONE = 'America/Sao_Paulo';

/** @param {Date|string} d @returns {number} epoch em segundos, p/ <t:…> do Discord. */
const unix = (d) => Math.floor(new Date(d).getTime() / 1000);

/** @param {number} v @param {Metric} metric */
export function formatValue(v, metric) {
  return metric.short ? shortNumber(v) : String(v);
}

/** Nome livre -> id estável e digitável (`Corrida de Raids` -> `corrida-de-raids`). */
export function slugify(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'evento';
}

/**
 * Quanto o relógio de `timeZone` está adiantado em relação ao UTC naquele
 * instante. Sai em ms, positivo a leste de Greenwich.
 */
function zoneOffsetMs(instant, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(
    fmt.formatToParts(instant).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  );
  // `hour` volta como 24 na virada do dia em algumas ICU.
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUTC - instant.getTime();
}

/**
 * Lê a data que a staff digitou, no fuso de Brasília.
 *
 * Aceita `29/07 00:00`, `29/07/2026 00:00`, `2026-07-29 00:00` e as três sem
 * hora (vira meia-noite). Sem ano, assume o ano corrente — e se isso jogar a
 * data para trás, assume o ano que vem, que é o que a pessoa quis dizer ao
 * escrever "05/01" em julho.
 *
 * @param {string} text
 * @param {Date} [now]
 * @returns {Date|null} null se não deu para entender
 */
export function parseStart(text, now = new Date()) {
  const s = String(text).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  const br = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (!iso && !br) return null;

  let year;
  let month;
  let day;
  let hour;
  let minute;
  if (iso) {
    [, year, month, day, hour = '0', minute = '0'] = iso;
  } else {
    [, day, month, year, hour = '0', minute = '0'] = br;
    if (year === undefined) year = null;
    else if (String(year).length === 2) year = `20${year}`;
  }

  month = Number(month);
  day = Number(day);
  hour = Number(hour);
  minute = Number(minute);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const build = (y) => {
    const guess = Date.UTC(y, month - 1, day, hour, minute);
    // Duas passadas: a primeira acha o offset aproximado, a segunda confirma
    // (importa só se a data cair exatamente numa troca de fuso).
    let t = guess - zoneOffsetMs(new Date(guess), TIMEZONE);
    t = guess - zoneOffsetMs(new Date(t), TIMEZONE);
    return new Date(t);
  };

  const anoCorrente = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric' }).format(now),
  );
  let out = build(year === null ? anoCorrente : Number(year));
  if (year === null && out < now) out = build(anoCorrente + 1);

  // Data impossível (31/02) escorrega para o mês seguinte: recusa em vez de
  // marcar um evento em dia nenhum.
  const check = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, day: 'numeric' }).format(out);
  if (Number(check) !== day) return null;

  return out;
}

/** O evento já começou a valer? */
export function hasStarted(event, now = new Date()) {
  return new Date(event.startAt) <= now;
}

/** Instante a partir do qual a apuração conta. Ver refreshScores. */
function countFrom(event) {
  return new Date(event.countFrom ?? event.startAt);
}

/** Slug livre: acrescenta -2, -3… se já existir um evento com o mesmo id. */
async function uniqueEventId(base) {
  const events = collections.events();
  let id = base;
  for (let n = 2; await events.findOne({ eventId: id }); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * Abre um evento. Nunca é retroativo: a apuração só olha para depois de
 * `startAt`, que pode ser agora ou uma data futura (ver refreshScores).
 *
 * @param {object} args
 * @param {string} args.name
 * @param {string} args.metricKey     chave de METRICS
 * @param {Date}   args.endAt         quando termina (data, não duração)
 * @param {string} args.prize         recompensas separadas por vírgula, uma por premiado
 * @param {string} [args.description] texto livre do evento, com `\n` para quebrar linha
 * @param {Date}   [args.startAt]     quando começa a valer (padrão: agora)
 * @param {number} [args.podium]      quantos colocados premiados
 * @param {number} [args.points]      pontos para o 1º lugar (metade a cada posição)
 * @param {string} args.guildDiscordId
 * @param {string} args.createdBy
 * @param {string} args.channelId     onde o painel do evento vive
 * @returns {Promise<object>} o evento criado
 */
export async function createEvent({
  name,
  metricKey,
  endAt,
  prize,
  description = '',
  startAt = null,
  podium = 1,
  points = 0,
  guildDiscordId,
  createdBy,
  channelId,
}) {
  const now = new Date();
  const inicio = startAt ? new Date(startAt) : now;
  const doc = {
    eventId: await uniqueEventId(slugify(name)),
    name: name.trim(),
    metric: metricKey,
    prize: prize.trim(),
    description: multiline(description),
    podium: Math.max(1, Math.min(10, podium)),
    points: Math.max(0, points),
    startAt: inicio,
    endAt: new Date(endAt),
    // Só as métricas sem gatilho precisam de um corte próprio, feito quando o
    // evento começa (ver jobs/eventTick.js). Guild raid é creditada ao vivo,
    // então o corte é o próprio `startAt`.
    countFrom: METRICS[metricKey]?.live ? inicio : null,
    status: 'active',
    guildDiscordId,
    createdBy,
    channelId,
    messageId: null,
    winners: [],
    createdAt: now,
  };
  await collections.events().insertOne(doc);
  return doc;
}

export function getEvent(eventId) {
  return collections.events().findOne({ eventId });
}

export function activeEvents(guildDiscordId = null) {
  return collections
    .events()
    .find({ status: 'active', ...(guildDiscordId && { guildDiscordId }) })
    .sort({ endAt: 1 })
    .toArray();
}

export function listEvents(limit = 15) {
  return collections.events().find({}).sort({ startAt: -1 }).limit(limit).toArray();
}

/** Evento ativo mais próximo do fim, ou o último encerrado se não houver ativo. */
export async function defaultEvent(guildDiscordId) {
  const [ativo] = await activeEvents(guildDiscordId);
  if (ativo) return ativo;
  return collections.events().findOne({ guildDiscordId }, { sort: { startAt: -1 } });
}

/**
 * Reapura a tabela secundária do evento a partir do livro-razão.
 *
 * SÓ CONTA O FUTURO. A janela é `at > startAt`, estritamente: o evento nasce
 * logo depois de uma apuração (ver /evento criar), então tudo o que a pessoa já
 * tinha feito ficou lançado ANTES do corte e não entra. Ninguém começa na
 * frente por causa do que fez semana passada.
 *
 * Pela mesma razão, eventos de linha de base (`meta.baseline`) ficam de fora:
 * o primeiro snapshot de um membro lança o XP e os guild raids que ele JÁ TINHA
 * ao aparecer. Sem o filtro, quem entrasse na guilda no meio do evento largaria
 * com uma vida inteira de números e venceria sem jogar.
 *
 * Empate no valor vai para quem CHEGOU NAQUELE NÚMERO PRIMEIRO. Como o total é
 * cumulativo, o instante em que a pessoa alcançou o valor final é o do seu
 * último lançamento — daí `reachedAt` ser o `$max` dos `at`, ordenado do mais
 * antigo para o mais novo. O nome entra como terceiro critério só para o
 * ranking não sacudir entre duas apurações quando até isso empata (a apuração
 * é diária, então dois lançamentos do mesmo dia têm o mesmo instante).
 *
 * @param {object} event
 * @returns {Promise<Array<{uuid:string, username:string, value:number, rank:number, reachedAt:Date}>>}
 */
export async function refreshScores(event) {
  const metric = METRICS[event.metric];
  if (!metric) return [];
  // Métrica com gatilho não se reconstrói do livro-razão: a tabela JÁ é o
  // registro, escrita no instante de cada raid (ver creditGuildRaid). Aqui só
  // as posições são refeitas.
  if (metric.live) return rerank(event.eventId);

  // Evento encerrado congela na data de encerramento; ativo conta até agora.
  const until = event.status === 'active' ? new Date() : new Date(event.endAt);

  const rows = await collections
    .pointsEvents()
    .aggregate([
      {
        $match: {
          type: metric.type,
          at: { $gt: countFrom(event), $lte: until },
          qty: { $gt: 0 },
          'meta.baseline': { $ne: true },
        },
      },
      { $sort: { at: 1 } },
      {
        $group: {
          _id: '$uuid',
          username: { $last: '$username' },
          value: { $sum: '$qty' },
          reachedAt: { $max: '$at' },
        },
      },
      { $sort: { value: -1, reachedAt: 1, username: 1 } },
    ])
    .toArray();

  const ranked = rows.map((r, i) => ({
    uuid: r._id,
    username: r.username,
    value: r.value,
    reachedAt: r.reachedAt,
    rank: i + 1,
  }));

  const scores = collections.eventScores();
  const now = new Date();
  if (ranked.length) {
    await scores.bulkWrite(
      ranked.map((r) => ({
        updateOne: {
          filter: { eventId: event.eventId, uuid: r.uuid },
          update: {
            $set: {
              username: r.username,
              value: r.value,
              rank: r.rank,
              reachedAt: r.reachedAt,
              updatedAt: now,
            },
          },
          upsert: true,
        },
      })),
    );
  }
  // Quem saiu da apuração (lançamento estornado, membro sem eventos na janela)
  // não pode ficar como lixo na tabela.
  await scores.deleteMany({ eventId: event.eventId, uuid: { $nin: ranked.map((r) => r.uuid) } });

  return ranked;
}

/**
 * Recalcula só as posições da tabela, sem mexer nos valores.
 *
 * Mesma ordem da apuração por janela: valor, depois quem chegou naquele número
 * primeiro, depois o nome como critério estável.
 *
 * @param {string} eventId
 * @returns {Promise<Array<object>>}
 */
async function rerank(eventId) {
  const scores = collections.eventScores();
  const rows = await scores.find({ eventId }).sort({ value: -1, reachedAt: 1, username: 1 }).toArray();

  const ops = rows
    .map((r, i) => ({ r, rank: i + 1 }))
    .filter(({ r, rank }) => r.rank !== rank)
    .map(({ r, rank }) => ({ updateOne: { filter: { _id: r._id }, update: { $set: { rank } } } }));
  if (ops.length) await scores.bulkWrite(ops);

  return rows.map((r, i) => ({
    uuid: r.uuid,
    username: r.username,
    value: r.value,
    reachedAt: r.reachedAt,
    rank: i + 1,
  }));
}

/**
 * GATILHO DA GUILD RAID. O watcher chama isto assim que vê uma raid terminar,
 * uma vez por membro do grupo.
 *
 * A tabela do evento anda AQUI, no instante do fato — não na contagem diária.
 * É o que permite marcar um evento para começar às 00:00 do dia 29 e ter certeza
 * de que a raid das 23:58 do dia 28 não entrou.
 *
 * `reachedAt` é reescrito a cada crédito de propósito: ele guarda quando a
 * pessoa chegou ao valor ATUAL, que é o critério de desempate.
 *
 * Raid feita com o bot fora do ar não entra no evento (os pontos, esses, a
 * contagem diária recupera depois).
 *
 * @param {{uuid: string, username: string, at?: Date}} raid
 * @returns {Promise<number>} em quantos eventos a raid foi creditada
 */
export async function creditGuildRaid({ uuid, username, at = new Date() }) {
  const alvos = await collections
    .events()
    .find({
      status: 'active',
      metric: { $in: Object.keys(METRICS).filter((k) => METRICS[k].live) },
      startAt: { $lte: at },
      endAt: { $gt: at },
    })
    .toArray();
  if (!alvos.length) return 0;

  for (const event of alvos) {
    await collections.eventScores().updateOne(
      { eventId: event.eventId, uuid },
      {
        $inc: { value: 1 },
        $set: { username, reachedAt: at, updatedAt: at },
        $setOnInsert: { firstAt: at },
      },
      { upsert: true },
    );
    await rerank(event.eventId);
  }
  log.info(`Guild raid de ${username} creditada em ${alvos.length} evento(s).`);
  return alvos.length;
}

/** Lê a tabela secundária já apurada (sem tocar no livro-razão). */
export function scoreboard(eventId, limit = 15) {
  // Mesma ordem da apuração, senão o painel mostraria um pódio e o anúncio outro.
  return collections
    .eventScores()
    .find({ eventId })
    .sort({ value: -1, reachedAt: 1, username: 1 })
    .limit(limit)
    .toArray();
}

/** Linha de um membro específico, para o "você está em Xº". */
export function memberScore(eventId, uuid) {
  return collections.eventScores().findOne({ eventId, uuid });
}

export function scoreCount(eventId) {
  return collections.eventScores().countDocuments({ eventId });
}

/**
 * Pontos da posição: o 1º leva `points`, e cada posição abaixo leva metade da
 * anterior. Zero significa "sem prêmio em pontos".
 * @param {number} points @param {number} rank
 */
export function podiumPoints(points, rank) {
  if (!points) return 0;
  return Math.round(points / 2 ** (rank - 1));
}

/**
 * Embed do ranking. Serve tanto para o painel fixo quanto para /evento ranking.
 * @param {object} event
 * @param {Array<object>} rows
 * @param {object} [opts]
 * @param {{rank:number, value:number}} [opts.me]  posição de quem pediu
 * @param {number} [opts.total]                    participantes na tabela
 */
export function renderEvent(event, rows, { me = null, total = null } = {}) {
  const metric = METRICS[event.metric] ?? { label: event.metric, emoji: '🏆', unit: '' };
  const encerrado = event.status !== 'active';
  const comecou = hasStarted(event);

  const lines = rows.length
    ? rows.map((r, i) => {
        const pos = MEDALS[i] || `\`${String(i + 1).padStart(2, ' ')}\``;
        const premiado = i < event.podium ? ' 🎁' : '';
        return `${pos} **${r.username}** — ${formatValue(r.value, metric)} ${metric.unit}${premiado}`;
      })
    : [comecou ? 'Ninguém pontuou ainda.' : '_A contagem começa quando o evento abrir._'];

  // A descrição da staff vem antes da tabela, com as quebras que ela pediu.
  const descricao = multiline(event.description);

  // Início e fim aparecem SEMPRE, os dois, com data absoluta e relativa: a
  // absoluta responde "que dia é isso?" e a relativa, "falta quanto?".
  const inicio = `<t:${unix(event.startAt)}:f>\n-# <t:${unix(event.startAt)}:R>`;
  const fim = `<t:${unix(event.endAt)}:f>\n-# ${encerrado ? 'encerrado' : 'termina'} <t:${unix(event.endAt)}:R>`;

  const prizes = parsePrizes(event.prize).slice(0, event.podium);
  const fields = [
    {
      name: prizes.length > 1 ? '🎁 Recompensas' : '🎁 Recompensa',
      value: renderPrizes(event.prize, event.podium),
      inline: false,
    },
    { name: '📊 Métrica', value: `${metric.emoji} ${metric.label}`, inline: true },
    { name: '🏅 Premiados', value: `Top ${event.podium}`, inline: true },
    { name: '​', value: '​', inline: true }, // fecha a linha de 3 colunas
    { name: '📅 Início', value: inicio, inline: true },
    { name: '🏁 Fim', value: fim, inline: true },
  ];
  // O corte da contagem só aparece quando NÃO é o próprio início (métricas sem
  // gatilho abrem com uma apuração, que pode cair alguns minutos depois).
  const corte = event.countFrom ? new Date(event.countFrom) : null;
  if (comecou && !encerrado && corte && corte.getTime() !== new Date(event.startAt).getTime()) {
    fields.push({ name: '🚦 Contando desde', value: `<t:${unix(corte)}:f>`, inline: true });
  }
  if (event.points) {
    fields.push({
      name: '⭐ Pontos',
      value: `1º leva ${event.points} pts (cada posição abaixo, metade)`,
      inline: false,
    });
  }
  if (me) {
    fields.push({
      name: '📍 Sua posição',
      value: `${me.rank}º — ${formatValue(me.value, metric)} ${metric.unit}`,
      inline: false,
    });
  }

  return {
    title: `${encerrado ? '🏁' : comecou ? '🏆' : '📅'} ${event.name}`,
    description: (descricao ? `${descricao}\n\n` : '') + lines.join('\n'),
    color: encerrado ? 0x95a5a6 : comecou ? 0xe67e22 : 0x3498db,
    fields,
    footer: {
      text:
        `Evento \`${event.eventId}\`` +
        (total !== null ? ` — ${total} participante(s)` : '') +
        ' — apurado de hora em hora',
    },
    timestamp: new Date().toISOString(),
  };
}

/** Canal do evento: o configurado em `events`, senão o de criação, senão `panel`. */
async function eventChannel(client, event) {
  const cfg = await getConfig(event.guildDiscordId);
  const ids = [event.channelId, cfg.channels?.events, cfg.channels?.panel].filter(Boolean);
  for (const id of ids) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) return ch;
  }
  return null;
}

/**
 * Publica (ou reedita) o painel do evento no canal. Se a mensagem sumiu, manda
 * outra — o painel se reconstrói sozinho, como os demais painéis fixos.
 * @param {import('discord.js').Client} client
 * @param {object} event
 */
export async function ensureEventPanel(client, event) {
  const channel = await eventChannel(client, event);
  if (!channel) return null;

  const rows = await scoreboard(event.eventId, 10);
  const total = await scoreCount(event.eventId);
  const payload = { embeds: [renderEvent(event, rows, { total })] };

  if (event.messageId) {
    const msg = await channel.messages.fetch(event.messageId).catch(() => null);
    if (msg) {
      await msg.edit(payload).catch(() => {});
      return msg;
    }
  }
  const msg = await channel.send(payload).catch(() => null);
  if (msg) {
    await collections
      .events()
      .updateOne({ eventId: event.eventId }, { $set: { messageId: msg.id, channelId: channel.id } });
  }
  return msg;
}

/**
 * Encerra o evento: congela a apuração, grava os vencedores, entrega os pontos
 * (se houver) e anuncia. Idempotente — um evento já encerrado não é reapurado.
 *
 * @param {import('discord.js').Client} client
 * @param {object} event
 * @param {{cancelled?: boolean}} [opts]
 * @returns {Promise<{winners: Array<object>}>}
 */
export async function endEvent(client, event, { cancelled = false } = {}) {
  if (event.status !== 'active') return { winners: event.winners ?? [] };

  const now = new Date();
  const endAt = new Date(event.endAt) > now ? now : new Date(event.endAt);
  const frozen = { ...event, status: cancelled ? 'cancelled' : 'ended', endAt };

  if (cancelled) {
    await collections
      .events()
      .updateOne({ eventId: event.eventId }, { $set: { status: 'cancelled', endAt, closedAt: now } });
    await ensureEventPanel(client, frozen);
    return { winners: [] };
  }

  const ranked = await refreshScores(frozen);
  const metric = METRICS[event.metric];

  // Vencedores levam o vínculo do Discord junto, para o anúncio poder marcar.
  const winners = [];
  for (const r of ranked.slice(0, event.podium)) {
    const member = await collections.members().findOne({ uuid: r.uuid }, { projection: { discordId: 1 } });
    winners.push({
      uuid: r.uuid,
      username: r.username,
      discordId: member?.discordId ?? null,
      value: r.value,
      rank: r.rank,
      points: podiumPoints(event.points, r.rank),
    });
  }

  await collections
    .events()
    .updateOne({ eventId: event.eventId }, { $set: { status: 'ended', endAt, closedAt: now, winners } });

  // Prêmio em pontos entra no livro-razão como concessão manual: aparece no
  // /profile, conta para a inatividade e é reversível como qualquer outro.
  for (const w of winners) {
    if (w.points > 0) {
      await awardPoints(w.uuid, w.username, w.points, `Evento ${event.name} (${w.rank}º lugar)`);
    }
  }

  await ensureEventPanel(client, { ...frozen, status: 'ended', winners });
  await announceWinners(client, { ...frozen, winners }, metric);

  log.info(`Evento ${event.eventId} encerrado com ${winners.length} vencedor(es).`);
  return { winners };
}

/** Anúncio do pódio no canal do evento, marcando quem está vinculado. */
async function announceWinners(client, event, metric) {
  const channel = await eventChannel(client, event);
  if (!channel) return;

  // Cada colocado leva a recompensa da SUA posição (1ª vírgula = 1º lugar).
  // Se a staff cadastrou menos recompensas que premiados, os de baixo saem sem.
  const prizes = parsePrizes(event.prize).slice(0, event.podium);
  const lines = event.winners.length
    ? event.winners.map((w) => {
        const quem = w.discordId ? `<@${w.discordId}> (**${w.username}**)` : `**${w.username}**`;
        const pts = w.points ? ` — \`+${w.points} pts\`` : '';
        const premio = prizes[w.rank - 1] ? ` — 🎁 **${prizes[w.rank - 1]}**` : '';
        return `${placeLabel(w.rank)} ${quem} — ${formatValue(w.value, metric)} ${metric.unit}${premio}${pts}`;
      })
    : ['Ninguém pontuou — o evento terminou sem vencedores.'];

  await channel
    .send({
      content:
        `🏁 **${event.name}** terminou!\n${lines.join('\n')}` +
        (event.winners.length ? '\n-# Falem com a staff para receber.' : ''),
      allowedMentions: { users: event.winners.map((w) => w.discordId).filter(Boolean) },
    })
    .catch(() => {});
}
