import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const BASE = 'https://api.wynncraft.com/v3';
const DEFAULT_TTL = 60_000; // 60s quando a resposta não traz Cache-Control

// Intervalo mínimo entre requisições, derivado do limite REAL da v3:
// 120 req/min com chave, 50 req/min sem. O valor antigo era 350ms fixos —
// ~171 req/min, acima dos dois — e por isso uma varredura grande (o "registrar
// todos pelo apelido", que faz uma consulta por membro) virava uma enxurrada de
// 429. A margem de ~20% cobre a imprecisão do relógio da janela do servidor.
const GAP_WITH_KEY = 600; // 100 req/min
const GAP_NO_KEY = 1_400; // ~43 req/min

// Teto de esperas por requisição. Passar disto é sinal de que a janela não vai
// abrir tão cedo, e insistir só empilha.
const MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 60_000;

const cache = new Map(); // url -> { expires, data }
let queue = Promise.resolve();
let lastReq = 0;

/**
 * Até quando a fila INTEIRA está de castigo. Um 429 não é problema de uma
 * requisição, é da janela toda: sem isto, as outras 200 chamadas já enfileiradas
 * saem mesmo assim, cada uma leva o próprio 429 e o log vira a enxurrada que
 * motivou esta mudança.
 */
let pausedUntil = 0;

function hasKey() {
  return !!optional('WYNN_API_KEY');
}

function authHeaders() {
  const key = optional('WYNN_API_KEY');
  // A v3 exige exatamente "Bearer <token>" — qualquer outro formato retorna
  // 400 MalformedTokenError. Com chave: 120 req/min; sem chave: 50 req/min.
  return key ? { Authorization: `Bearer ${key}` } : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function throttle() {
  const gap = hasKey() ? GAP_WITH_KEY : GAP_NO_KEY;
  const espera = Math.max(0, lastReq + gap - Date.now(), pausedUntil - Date.now());
  if (espera) await sleep(espera);
  lastReq = Date.now();
}

/** Quanto esperar depois de um 429: o que o servidor mandar, ou um minuto. */
function backoffMs(res, tentativa) {
  const header = res.headers.get('retry-after');
  if (header) {
    const segundos = Number(header);
    if (Number.isFinite(segundos) && segundos > 0) return Math.min(segundos * 1000, 5 * 60_000);
    const data = Date.parse(header); // a RFC também permite uma data
    if (Number.isFinite(data)) return Math.max(0, Math.min(data - Date.now(), 5 * 60_000));
  }
  return DEFAULT_BACKOFF_MS * tentativa;
}

function request(path, { fresh = false } = {}) {
  const url = `${BASE}${path}`;
  if (!fresh) {
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.data);
  }

  // Serializa as requisições numa fila para respeitar o rate-limit.
  const run = queue.then(async () => {
    for (let tentativa = 1; ; tentativa += 1) {
      await throttle();
      const res = await fetch(url, {
        headers: { Accept: 'application/json', ...authHeaders() },
      });
      if (res.status === 404) return null;

      if (res.status === 429) {
        const espera = backoffMs(res, tentativa);
        pausedUntil = Date.now() + espera;
        if (tentativa > MAX_RETRIES) {
          log.warn(`WynnCraft API: 429 persistente em ${path}, desisti após ${MAX_RETRIES} tentativas.`);
          throw new Error('rate_limited');
        }
        // Um aviso por espera, e não um por requisição enfileirada.
        log.warn(`WynnCraft API: rate limited (429). Pausando ${Math.round(espera / 1000)}s (tentativa ${tentativa}/${MAX_RETRIES}).`);
        continue;
      }

      if (!res.ok) throw new Error(`WynnCraft API ${res.status} em ${path}`);
      const data = await res.json();

      let ttl = DEFAULT_TTL;
      const cc = res.headers.get('cache-control');
      const m = cc && cc.match(/max-age=(\d+)/);
      if (m) ttl = Number(m[1]) * 1000;
      cache.set(url, { expires: Date.now() + ttl, data });
      return data;
    }
  });
  queue = run.catch(() => {}); // um erro não pode travar a fila
  return run;
}

/**
 * Distingue "a API disse que não existe" de "não consegui perguntar".
 *
 * Importa porque quase todo chamador faz `.catch(() => null)`, e sem esta
 * diferença um 429 vira "esse nick não existe" — o registro chegou a dizer isso
 * a gente de verdade durante uma janela de rate limit.
 */
export function isRateLimited(err) {
  return err instanceof Error && err.message === 'rate_limited';
}

export const wynn = {
  player: (nick, opts) => request(`/player/${encodeURIComponent(nick)}?fullResult`, opts),
  guildByPrefix: (prefix, opts) => request(`/guild/prefix/${encodeURIComponent(prefix)}`, opts),
  guildByName: (name, opts) => request(`/guild/name/${encodeURIComponent(name)}`, opts),
  territoryList: (opts) => request(`/guild/list/territory`, opts),
  leaderboardTypes: (opts) => request(`/leaderboards/types`, opts),
  // Ranking de uma season da guilda. Chaves são as posições ("1", "2", ...).
  guildSeasonBoard: (n, limit = 3, opts) =>
    request(`/leaderboards/guildSeason${n}?resultLimit=${limit}`, opts),
};
