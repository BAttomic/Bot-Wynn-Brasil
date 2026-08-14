import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { optional } from './config/env.js';
import { log } from './util/log.js';

// Arquivos servidos publicamente. Ficam em src/assets/ e entram na imagem
// Docker (o .dockerignore só corta *.md, node_modules, .env e .git).
//
// modpack — grande demais (~27 MB) para anexo de bot no Discord, então
//           servimos por HTTP e o /modpack só devolve o link.
// gsw     — o dossiê GsW × Wynn Brasil, uma página autocontida (~3,5 MB, com
//           os prints embutidos em base64). Gerada por gsw/build.ps1.
const ASSETS = {
  '/modpack': {
    file: 'mods.rar',
    type: 'application/vnd.rar',
    download: true,
    maxAge: 3600,
    missing: 'modpack indisponível',
  },
  '/gsw': {
    file: 'gsw.html',
    type: 'text/html; charset=utf-8',
    download: false,
    // curto de propósito: a página é regerada pelo build e o link é fixo.
    maxAge: 300,
    missing: 'dossiê indisponível',
  },
};

/**
 * Envia um arquivo de src/assets/ inteiro, por stream.
 * @param {import('node:http').ServerResponse} res
 * @param {(typeof ASSETS)[string]} asset
 * @param {boolean} headOnly
 */
function serveAsset(res, asset, headOnly) {
  const path = fileURLToPath(new URL(`./assets/${asset.file}`, import.meta.url));
  let size;
  try {
    size = statSync(path).size;
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: asset.missing }));
    return;
  }
  const headers = {
    'Content-Type': asset.type,
    'Content-Length': size,
    'Cache-Control': `public, max-age=${asset.maxAge}`,
  };
  // Sem disposition o navegador abre a página; com ela, baixa o arquivo.
  if (asset.download) headers['Content-Disposition'] = `attachment; filename="${asset.file}"`;
  res.writeHead(200, headers);
  if (headOnly) {
    res.end();
    return;
  }
  const stream = createReadStream(path);
  stream.on('error', (e) => {
    log.error(`Falha ao servir ${asset.file}:`, e);
    res.destroy();
  });
  stream.pipe(res);
}

// Servidor HTTP mínimo para healthcheck do Easypanel/Dokploy (sem dependências)
// e para os arquivos públicos de src/assets/.
export function startHealthServer(getState) {
  const port = Number(optional('PORT', '8080'));
  const server = createServer((req, res) => {
    // Ignora query string: /gsw?utm=... continua caindo na rota.
    const path = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (ASSETS[path]) {
      serveAsset(res, ASSETS[path], req.method === 'HEAD');
    } else if (path === '/health' || path === '/') {
      const ready = getState();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const rotas = ['/health', ...Object.keys(ASSETS)].join(', ');
  server.listen(port, () => log.info(`HTTP em :${port} (${rotas})`));
  return server;
}
