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
  await collections.territoryCaptures().insertOne({ ...doc, at: new Date() });
}
