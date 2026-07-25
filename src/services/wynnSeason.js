import { wynn } from '../wynn/api.js';
import { log } from '../util/log.js';

// Descobre em qual season do Wynncraft estamos, e se ela está em andamento.
//
// A API não tem um endpoint "season atual". Deduzimos de dois sinais:
//
//   1. O número da season mais recente é o maior `guildSeasonN` em
//      /leaderboards/types. Quando a 32 começar, o tipo aparece sozinho.
//
//   2. Uma season só é encerrada quando o Wynncraft congela o `finalTerritories`
//      de cada guilda. Durante a season, esse campo é 0 para todas. Olhamos as
//      guildas do TOPO do ranking daquela season: se alguma já tem território
//      final registrado, a season acabou. Não dá para olhar uma guilda qualquer
//      — a WnBR terminou todas as suas seasons com 0 territórios, e isso é
//      indistinguível de uma season em andamento.

const CACHE_MS = 30 * 60_000; // a season não muda de minuto em minuto
const TOP_SAMPLE = 3;

let cache = null; // { at, value }

function highestSeason(types) {
  let best = null;
  for (const t of types) {
    const m = /^guildSeason(\d+)$/.exec(t);
    if (m) {
      const n = Number(m[1]);
      if (best === null || n > best) best = n;
    }
  }
  return best;
}

async function seasonIsOver(number) {
  const board = await wynn.guildSeasonBoard(number, TOP_SAMPLE);
  const leaders = Object.values(board || {});
  // Season recém-aberta, ninguém pontuou: está em andamento.
  if (!leaders.length) return false;

  for (const leader of leaders) {
    if (!leader?.prefix) continue;
    const guild = await wynn.guildByPrefix(leader.prefix).catch(() => null);
    const final = guild?.seasonRanks?.[String(number)]?.finalTerritories ?? 0;
    if (Number(final) > 0) return true;
  }
  return false;
}

export function seasonIdFor({ number, active }) {
  return active ? `S${number}` : `OFF-${number}`;
}

// Devolve { number, active, id } ou null se a API não responder.
export async function currentWynnSeason({ fresh = false } = {}) {
  if (!fresh && cache && cache.at + CACHE_MS > Date.now()) return cache.value;

  try {
    const types = await wynn.leaderboardTypes();
    const number = highestSeason(types || []);
    if (number === null) return cache?.value ?? null;

    const active = !(await seasonIsOver(number));
    const value = { number, active, id: seasonIdFor({ number, active }) };
    cache = { at: Date.now(), value };
    log.info(`Season do Wynncraft: ${value.id} (${active ? 'em andamento' : 'off-season'}).`);
    return value;
  } catch (e) {
    log.error('Falha ao detectar a season do Wynncraft:', e);
    return cache?.value ?? null; // melhor o último valor conhecido que nenhum
  }
}
