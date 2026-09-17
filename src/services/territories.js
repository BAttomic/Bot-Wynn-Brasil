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
    defences: t.defences ?? null,
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
 * @param {Array<{captureId: string, at: number, multiplier: number}>} captures
 * @param {Array<{uuid: string, username: string, at: number, delta: number}>} increments
 * @param {{beforeMs: number, afterMs: number}} janela
 * @returns {Array<{captureId: string, uuid: string, username: string, multiplier: number, at: number}>}
 */
export function attributeCaptures(captures, increments, { beforeMs, afterMs }) {
  // Orçamento por pessoa: uma marca por guerra que o contador dela acusou.
  const orcamento = new Map();
  for (const inc of increments) {
    const n = Math.max(0, Math.floor(Number(inc.delta) || 0));
    if (!n || !inc.uuid) continue;
    const b = orcamento.get(inc.uuid) || { username: inc.username, marcas: [] };
    for (let i = 0; i < n; i += 1) b.marcas.push(Number(inc.at));
    if (inc.username) b.username = inc.username;
    orcamento.set(inc.uuid, b);
  }
  for (const b of orcamento.values()) b.marcas.sort((x, y) => x - y);

  const out = [];
  for (const cap of [...captures].sort((a, b) => a.at - b.at)) {
    for (const [uuid, b] of orcamento) {
      const i = b.marcas.findIndex((at) => at >= cap.at - beforeMs && at <= cap.at + afterMs);
      if (i === -1) continue;
      b.marcas.splice(i, 1);
      out.push({ captureId: cap.captureId, uuid, username: b.username, multiplier: cap.multiplier, at: cap.at });
    }
  }
  return out;
}
