import express from 'express';
import { createServer } from 'node:http';
import { createAuthRouter } from './auth.js';
import { config } from './config.js';
import { closeDb, getDb } from './db.js';
import { handlePigeonWebhook, startOutboundWorker, stopOutboundWorker } from './pigeon.js';
import { closeRedis, getRedis } from './redis.js';
import { createApiRouter } from './routes.js';
import { attachWebSocketServer } from './ws.js';

async function main() {
  await getDb();
  await getRedis().ping();

  const app = express();

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  // Raw body required for HMAC-SHA256 webhook signature verification
  app.post('/webhooks/pigeon', express.raw({ type: '*/*', limit: '1mb' }), (req, res, next) => {
    handlePigeonWebhook(req, res).catch(next);
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(createAuthRouter());
  app.use(createApiRouter());

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error' });
    }
  });

  const server = createServer(app);
  const closeWs = attachWebSocketServer(server);
  startOutboundWorker();

  server.listen(config.port, () => {
    console.log(`server on http://localhost:${config.port}`);
  });

  const shutdown = async () => {
    stopOutboundWorker();
    await closeWs();
    server.close();
    await closeDb();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
