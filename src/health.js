import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { optional } from './config/env.js';
import { dataDir, MRPACK_FILE, ZIP_FILE } from './services/modpack.js';
import { log } from './util/log.js';

// Arquivos servidos publicamente. Vêm de dois lugares:
//
//   asset — src/assets/, versionado no git e embutido na imagem Docker (o
//           .dockerignore só corta *.md, node_modules, .env e .git).
//   data  — DATA_DIR, gerado em runtime e guardado em volume. É o modpack, que
//           o job diário remonta a partir do Modrinth (ver services/modpack.js).
const ROUTES = {
  // O link histórico. Serve o zip gerado; enquanto o job não rodar pela primeira
  // vez (deploy novo, volume vazio), cai no mods.rar do repo em vez de dar 404.
  '/modpack': { data: ZIP_FILE, fallback: 'mods.rar', maxAge: 300, missing: 'modpack indisponível' },
  // O formato que os launchers (Modrinth App, Prism, ATLauncher) atualizam sozinhos.
  '/modpack.mrpack': { data: MRPACK_FILE, maxAge: 300, missing: 'modpack ainda não foi gerado' },
  // Legado explícito: o pacote congelado, para quem já tem o link antigo salvo.
  '/modpack.rar': { asset: 'mods.rar', maxAge: 3600, missing: 'modpack indisponível' },
  // O dossiê GsW × Wynn Brasil, uma página autocontida (~3,5 MB, com os prints
  // embutidos em base64). Gerada por gsw/build.ps1. Cache curto de propósito: a
  // página é regerada pelo build e o link é fixo.
  '/gsw': { asset: 'gsw.html', maxAge: 300, missing: 'dossiê indisponível' },
};

// Tipo pela extensão, e não por rota: /modpack serve um .zip no caso normal e um
// .rar no fallback, e anunciar o Content-Type errado faria o navegador salvar um
// arquivo que não abre.
const TYPES = {
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.mrpack': 'application/x-modrinth-modpack+zip',
  '.html': 'text/html; charset=utf-8',
};

/** Caminho no disco de uma rota, ou null se nem o arquivo nem o fallback existem. */
function resolvePath(route) {
  if (route.data) {
    const gerado = join(dataDir(), route.data);
    if (existsSync(gerado)) return gerado;
  }
  const asset = route.asset ?? route.fallback;
  if (!asset) return null;
  const path = fileURLToPath(new URL(`./assets/${asset}`, import.meta.url));
  return existsSync(path) ? path : null;
}

/**
 * Envia um arquivo inteiro, por stream.
 * @param {import('node:http').ServerResponse} res
 * @param {(typeof ROUTES)[string]} route
 * @param {boolean} headOnly
 */
function serveFile(res, route, headOnly) {
  const path = resolvePath(route);
  let size;
  try {
    if (!path) throw new Error(route.missing);
    size = statSync(path).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: route.missing }));
    return;
  }
  const nome = basename(path);
  const headers = {
    'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': `public, max-age=${route.maxAge}`,
    // Sem disposition o navegador tenta abrir; com ela, baixa. O .html do dossiê
    // é para abrir, todo o resto é para baixar.
    ...(extname(path) === '.html' ? {} : { 'Content-Disposition': `attachment; filename="${nome}"` }),
  };
  res.writeHead(200, headers);
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', (e) => {
    log.error(`Falha ao servir ${nome}:`, e);
    res.destroy();
  });
  stream.pipe(res);
}

// Servidor HTTP mínimo para healthcheck do Easypanel/Dokploy (sem dependências)
// e para os arquivos públicos.
export function startHealthServer(getState) {
  const port = Number(optional('PORT', '8080'));
  const server = createServer((req, res) => {
    // Ignora query string: /gsw?utm=... continua caindo na rota.
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (ROUTES[path]) {
      serveFile(res, ROUTES[path], req.method === 'HEAD');
    } else if (path === '/health' || path === '/') {
      const ready = getState();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const rotas = ['/health', ...Object.keys(ROUTES)].join(', ');
  server.listen(port, () => log.info(`HTTP em :${port} (${rotas})`));
  return server;
}
