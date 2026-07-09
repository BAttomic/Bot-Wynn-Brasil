import { optional } from '../config/env.js';
import { log } from '../util/log.js';

const BASE = 'https://api.wynncraft.com/v3';
const DEFAULT_TTL = 60_000; // 60s quando a resposta não traz Cache-Control
const MIN_GAP_MS = 350; // intervalo mínimo entre requisições (respeita rate-limit)

const cache = new Map(); // url -> { expires, data }
let queue = Promise.resolve();
let lastReq = 0;

function authHeaders() {
  const key = optional('WYNN_API_KEY');
  // A v3 exige exatamente "Bearer <token>" — qualquer outro formato retorna
  // 400 MalformedTokenError. Com chave: 120 req/min; sem chave: 50 req/min.
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function throttle() {
  const wait = Math.max(0, lastReq + MIN_GAP_MS - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
}

function request(path, { fresh = false } = {}) {
  const url = `${BASE}${path}`;
  if (!fresh) {
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.data);
  }

  // Serializa as requisições numa fila para respeitar o rate-limit.
  const run = queue.then(async () => {
    await throttle();
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...authHeaders() },
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      log.warn('WynnCraft API: rate limited (429)');
      throw new Error('rate_limited');
    }
    if (!res.ok) throw new Error(`WynnCraft API ${res.status} em ${path}`);
    const data = await res.json();

    let ttl = DEFAULT_TTL;
    const cc = res.headers.get('cache-control');
    const m = cc && cc.match(/max-age=(\d+)/);
    if (m) ttl = Number(m[1]) * 1000;
    cache.set(url, { expires: Date.now() + ttl, data });
    return data;
  });
  queue = run.catch(() => {}); // um erro não pode travar a fila
  return run;
}

export const wynn = {
  player: (nick, opts) => request(`/player/${encodeURIComponent(nick)}?fullResult`, opts),
  guildByPrefix: (prefix, opts) => request(`/guild/prefix/${encodeURIComponent(prefix)}`, opts),
  guildByName: (name, opts) => request(`/guild/name/${encodeURIComponent(name)}`, opts),
  territoryList: (opts) => request(`/guild/list/territory`, opts),
};
