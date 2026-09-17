import { collections } from '../db/mongo.js';

// Valor de um território capturado, espelhando o multiplicador de dano/vida que
// a torre do defensor realmente tinha (Wynncraft Wiki, "Guild War"):
//
//   território normal: stat * (1 + 0.3 * conexões)
//   quartel-general:   stat * (1.5 + 0.25 * externals) * (1 + 0.3 * conexões)
//
// "conexões" = territórios vizinhos que o DEFENSOR possuía.
// "externals" = territórios do defensor a até 3 saltos do HQ dele. A wiki é
// explícita: os territórios do caminho NÃO precisam ser dele para contar.

export const EXTERNAL_DEPTH = 3;

function ownerOf(territories, name) {
  return territories[name]?.guild?.prefix ?? null;
}

export function countConnections(territories, name, prefix) {
  const links = territories[name]?.links ?? [];
  return links.filter((n) => ownerOf(territories, n) === prefix).length;
}

export function countExternals(territories, hqName, prefix, depth = EXTERNAL_DEPTH) {
  if (!hqName || !territories[hqName]) return 0;

  const seen = new Set([hqName]);
  let frontier = [hqName];
  let count = 0;

  for (let d = 0; d < depth; d += 1) {
    const next = [];
    for (const current of frontier) {
      for (const neighbour of territories[current]?.links ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        next.push(neighbour);
        if (ownerOf(territories, neighbour) === prefix) count += 1;
      }
    }
    frontier = next;
  }
  return count;
}

export function towerMultiplier({ connections, externals = 0, isHq = false }) {
  const connectionBonus = 1 + 0.3 * connections;
  if (!isHq) return connectionBonus;
  return (1.5 + 0.25 * externals) * connectionBonus;
}

// Avalia um território a partir do estado ANTERIOR à captura — é ali que o
// defensor ainda aparece como dono e as fronteiras dele ainda contam.
export function captureValue(territories, name) {
  const t = territories?.[name];
  const prefix = t?.guild?.prefix ?? null;
  if (!prefix) {
    return { defender: null, connections: 0, externals: 0, isHq: false, multiplier: 1 };
  }

  const isHq = t.hq === true;
  const connections = countConnections(territories, name, prefix);
  const externals = isHq ? countExternals(territories, name, prefix) : 0;

  return {
    defender: prefix,
    defenderName: t.guild.name ?? null,
    // Nota de defesa e tesouro do DEFENSOR, como o jogo classifica (VERY_LOW ..
    // VERY_HIGH). Nao entram na conta de pontos hoje, mas sao o unico sinal da
    // API que reflete os upgrades de torre do defensor — ficam gravados na
    // captura para uma eventual ponderação por dificuldade real.
    defences: t.defences ?? null,
    treasury: t.treasury ?? null,
    isHq,
    connections,
    externals,
    multiplier: towerMultiplier({ connections, externals, isHq }),
  };
}

export async function recordCapture(doc) {
  // O `at` de quem chama vence: a captura aconteceu no poll, e o registro sai no
  // resumo, até uma hora depois. Carimbar a hora da gravação jogaria a captura
  // para fora da janela de atribuição de quem for reprocessar isso depois.
  await collections.territoryCaptures().insertOne({ at: new Date(), ...doc });
}

/**
 * Id estável de uma captura, para a gravação de pontos ser idempotente.
 * Território + instante: a mesma captura nunca acontece duas vezes no mesmo ms.
 */
export function captureId(territory, at) {
  return `${territory}@${new Date(at).toISOString()}`;
}

/**
 * Quem leva o peso de cada captura.
 *
 * A API não diz quem capturou o quê (ver o bloco de atribuição no topo de
 * services/watcher.js), então a ligação continua sendo por janela de tempo. O
 * que muda em relação à versão que foi removida em agosto é o ORÇAMENTO: cada
 * incremento do contador de guerra de uma pessoa é gasto UMA vez só.
 *
 * Era esse o furo. A janela era consultada por captura, então três capturas
 * numa hora davam três créditos a cada guerreiro do intervalo — inclusive a
 * quem tinha guerreado uma vez. Agora quem guerreou 1 leva 1 captura, quem
 * guerreou 3 leva 3, e ninguém leva mais capturas do que guerras que fez.
 *
 * O que continua sendo palpite, e não tem como deixar de ser: quem guerreou por
 * OUTRO território (ou por outra guilda) na mesma janela entra no rateio. O
 * contador da API é um número só, sem dizer por onde a guerra foi.
 *
 * As capturas são percorridas em ordem cronológica e cada pessoa gasta primeiro
 * o incremento mais antigo que serve, para o crédito seguir a ordem dos fatos.
 *
 * Cada incremento vale pela JANELA em que ele pode ter acontecido. O caminho ao
 * vivo conhece o instante do poll (`at`) e a janela sai de `beforeMs`/`afterMs`.
 * Quem reprocessa o passado nao tem essa precisao: o livro-razao so diz "N
 * guerras entre um snapshot e o seguinte", e ai o incremento traz `from`/`to`
 * com o intervalo inteiro. A conta e a mesma; o que muda e o tamanho da janela.
 *
 * @param {Array<{captureId: string, at: number, multiplier: number}>} captures
 * @param {Array<{uuid: string, username: string, delta: number, at?: number, from?: number, to?: number}>} increments
 * @param {{beforeMs: number, afterMs: number}} janela  padrao para incremento sem from/to
 * @returns {Array<{captureId: string, uuid: string, username: string, multiplier: number, at: number}>}
 */
export function attributeCaptures(captures, increments, { beforeMs, afterMs }) {
  // Orçamento por pessoa: uma marca por guerra que o contador dela acusou, cada
  // uma com a janela em que aquela guerra pode ter sido.
  const orcamento = new Map();
  for (const inc of increments) {
    const n = Math.max(0, Math.floor(Number(inc.delta) || 0));
    if (!n || !inc.uuid) continue;
    // A janela de uma marca pontual é a das CAPTURAS que ela pode ter pago, e ela
    // olha para TRÁS: o contador é cacheado pesado, então o incremento aparece
    // depois da captura (até `afterMs`), e no máximo `beforeMs` antes — essa
    // folga curta só cobre a ordem entre dois polls vizinhos.
    const from = Number(inc.from ?? Number(inc.at) - afterMs);
    const to = Number(inc.to ?? Number(inc.at) + beforeMs);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const b = orcamento.get(inc.uuid) || { username: inc.username, marcas: [] };
    for (let i = 0; i < n; i += 1) b.marcas.push({ from, to });
    if (inc.username) b.username = inc.username;
    orcamento.set(inc.uuid, b);
  }
  // Marca mais ANTIGA primeiro, e entre duas que começam junto, a mais curta —
  // gastar a janela larga antes desperdiçaria a única que serve para a captura
  // seguinte.
  for (const b of orcamento.values()) {
    b.marcas.sort((x, y) => x.from - y.from || x.to - y.to);
  }

  const out = [];
  for (const cap of [...captures].sort((a, b) => a.at - b.at)) {
    for (const [uuid, b] of orcamento) {
      const i = b.marcas.findIndex((m) => cap.at >= m.from && cap.at <= m.to);
      if (i === -1) continue;
      b.marcas.splice(i, 1);
      out.push({ captureId: cap.captureId, uuid, username: b.username, multiplier: cap.multiplier, at: cap.at });
    }
  }
  return out;
}
