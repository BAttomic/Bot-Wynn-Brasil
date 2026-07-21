import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optional } from './config/env.js';
import { log } from './util/log.js';

// Modpack oficial servido para download público. Fica em src/assets/ e entra na
// imagem Docker (o .dockerignore só corta *.md, node_modules, .env e .git).
const MODPACK_FILE = 'mods.rar';
const MODPACK_PATH = fileURLToPath(new URL(`./assets/${MODPACK_FILE}`, import.meta.url));

/**
 * Envia o modpack como download. Grande demais (~27 MB) para anexo de bot no
 * Discord, então servimos por HTTP e o /modpack só devolve o link.
 * @param {import('node:http').ServerResponse} res
 * @param {boolean} headOnly
 */
function serveModpack(res, headOnly) {
  let size;
  try {
    size = statSync(MODPACK_PATH).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'modpack indisponível' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.rar',
    'Content-Disposition': `attachment; filename="${MODPACK_FILE}"`,
    'Content-Length': size,
    'Cache-Control': 'public, max-age=3600',
  });
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(MODPACK_PATH);
  stream.on('error', (e) => {
    log.error('Falha ao servir o modpack:', e);
    res.destroy();
  });
  stream.pipe(res);
}

// Servidor HTTP mínimo para healthcheck do Easypanel/Dokploy (sem dependências)
// e para o download público do modpack.
export function startHealthServer(getState) {
  const port = Number(optional('PORT', '8080'));
  const server = createServer((req, res) => {
    if (req.url === '/modpack') {
      serveModpack(res, req.method === 'HEAD');
    } else if (req.url === '/health' || req.url === '/') {
      const ready = getState();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => log.info(`HTTP em :${port} (/health, /modpack)`));
  return server;
}
