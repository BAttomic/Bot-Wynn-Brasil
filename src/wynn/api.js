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

      // 300 Multiple Choices: o nome consultado casa com MAIS DE UMA conta
      // (alguém já usou esse nick antes, ou duas contas diferem só na caixa). O
      // corpo traz os candidatos — quem chamou é que sabe escolher, então ele
      // viaja no erro em vez de virar um `throw` genérico. Sem isto, um único
      // nick ambíguo derrubava a varredura inteira do /reconciliar.
      if (res.status === 300) {
        const body = await res.json().catch(() => null);
        const err = new Error(`WynnCraft API 300 (mais de uma conta) em ${path}`);
        err.code = 'multiple_choices';
        err.choices = normalizeChoices(body);
        throw err;
      }

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
 * O corpo do 300 é um mapa `uuid -> { storedName, uuid }`. Algumas respostas
 * trazem só a string do nome no lugar do objeto, então os dois formatos são
 * aceitos. Sai uma lista simples de `{ uuid, username }`.
 */
function normalizeChoices(body) {
  if (!body || typeof body !== 'object') return [];
  const out = [];
  for (const [uuid, v] of Object.entries(body)) {
    const username = typeof v === 'string' ? v : v?.storedName ?? v?.username ?? null;
    out.push({ uuid: v?.uuid ?? uuid, username });
  }
  return out.filter((c) => c.uuid);
}

/**
 * Consulta de jogador com o 300 resolvido.
 *
 * A escolha é conservadora de propósito: vincular a conta ERRADA é pior que não
 * vincular. Só decidimos quando não há dúvida — grafia idêntica, ou um único
 * candidato que case ignorando a caixa. Fora isso o erro sobe com a lista de
 * candidatos, para quem chamou dizer à staff qual grafia usar.
 */
async function playerLookup(nick, opts) {
  const alvo = String(nick ?? '').trim();
  try {
    return await request(`/player/${encodeURIComponent(alvo)}?fullResult`, opts);
  } catch (e) {
    if (e?.code !== 'multiple_choices') throw e;

    const choices = e.choices ?? [];
    const exato = choices.filter((c) => c.username === alvo);
    const semCaixa = choices.filter((c) => c.username?.toLowerCase() === alvo.toLowerCase());
    const escolhido = exato.length === 1 ? exato[0] : semCaixa.length === 1 ? semCaixa[0] : null;

    if (!escolhido) {
      e.message = `WynnCraft API: "${alvo}" corresponde a mais de uma conta (${
        choices.map((c) => c.username ?? c.uuid).join(', ') || 'candidatos desconhecidos'
      })`;
      throw e;
    }
    // O UUID é único, então esta segunda consulta nunca volta 300.
    return request(`/player/${encodeURIComponent(escolhido.uuid)}?fullResult`, opts);
  }
}

/**
 * "Esse nick pertence a mais de uma conta e não dá para adivinhar qual."
 *
 * Diferente de "não existe": o jogador existe, o que falta é a grafia exata.
 * `err.choices` traz os candidatos.
 */
export function isAmbiguousPlayer(err) {
  return err instanceof Error && err.code === 'multiple_choices';
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
  player: (nick, opts) => playerLookup(nick, opts),
  guildByPrefix: (prefix, opts) => request(`/guild/prefix/${encodeURIComponent(prefix)}`, opts),
  guildByName: (name, opts) => request(`/guild/name/${encodeURIComponent(name)}`, opts),
  territoryList: (opts) => request(`/guild/list/territory`, opts),
  leaderboardTypes: (opts) => request(`/leaderboards/types`, opts),
  // Ranking de uma season da guilda. Chaves são as posições ("1", "2", ...).
  guildSeasonBoard: (n, limit = 3, opts) =>
    request(`/leaderboards/guildSeason${n}?resultLimit=${limit}`, opts),
};
