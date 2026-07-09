import { createServer } from 'node:http';
import { optional } from './config/env.js';
import { log } from './util/log.js';

// Servidor HTTP mínimo para healthcheck do Easypanel (sem dependências).
export function startHealthServer(getState) {
  const port = Number(optional('PORT', '8080'));
  const server = createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const ready = getState();
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'starting' }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, () => log.info(`Healthcheck HTTP em :${port}/health`));
  return server;
}
