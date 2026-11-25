import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { getSessionFromCookieHeader, getWorkspaceRole } from './auth.js';
import { config } from './config.js';
import { collections } from './db.js';
import { createRedisSubscriber } from './redis.js';

function isAllowedOrigin(originHeader: string | undefined, hostHeader: string | undefined): boolean {
  if (!originHeader) return true; // non-browser WS clients (e.g., check.js) omit Origin
  try {
    const o = new URL(originHeader);
    const web = new URL(config.webOrigin);
    if (o.origin === web.origin) return true;
    if (hostHeader && o.host === hostHeader) return true;
    return false;
  } catch {
    return false;
  }
}

export function attachWebSocketServer(server: HttpServer): () => Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  const sub = createRedisSubscriber();
  const rooms = new Map<string, Set<WebSocket>>();
  const aliveSet = new WeakSet<WebSocket>();

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!aliveSet.has(ws)) {
        ws.terminate();
        continue;
      }
      aliveSet.delete(ws);
      ws.ping();
    }
  }, 25_000);

  sub.on('message', (channel, message) => {
    if (!channel.startsWith('ws:')) return;
    const workspace = channel.slice(3);
    const clients = rooms.get(workspace);
    if (!clients) return;
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(message);
      }
    }
  });

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const workspace = url.searchParams.get('workspace') || '';
      const user = await getSessionFromCookieHeader(req.headers.cookie);
      if (!user || !workspace || !getWorkspaceRole(user, workspace)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const afterParam = url.searchParams.get('after');
      const after = afterParam !== null && afterParam !== '' ? Number(afterParam) : null;

      wss.handleUpgrade(req, socket, head, async (ws) => {
        aliveSet.add(ws);
        ws.on('pong', () => aliveSet.add(ws));

        const buffer: string[] = [];
        let replaying = true;
        let maxReplayedSeq = after !== null && Number.isFinite(after) ? after : -1;

        let clients = rooms.get(workspace);
        if (!clients) {
          clients = new Set();
          rooms.set(workspace, clients);
          await sub.subscribe(`ws:${workspace}`);
        }

        const proxyWs = {
          get readyState() {
            return ws.readyState;
          },
          OPEN: ws.OPEN,
          send(data: string) {
            if (replaying) {
              buffer.push(data);
              return;
            }
            ws.send(data);
          },
        } as unknown as WebSocket;

        clients.add(proxyWs);

        ws.on('close', () => {
          const set = rooms.get(workspace);
          if (set) {
            set.delete(proxyWs);
            if (set.size === 0) {
              rooms.delete(workspace);
              void sub.unsubscribe(`ws:${workspace}`).catch(() => {});
            }
          }
        });

        try {
          if (after !== null && Number.isFinite(after)) {
            const { events } = await collections();
            const missed = await events
              .find({ workspace, seq: { $gt: after } })
              .sort({ seq: 1 })
              .limit(1000)
              .toArray();
            for (const ev of missed) {
              if (ws.readyState !== ws.OPEN) break;
              ws.send(JSON.stringify(ev.payload));
              if (ev.seq > maxReplayedSeq) maxReplayedSeq = ev.seq;
            }
          }
        } finally {
          replaying = false;
          for (const raw of buffer) {
            if (ws.readyState !== ws.OPEN) break;
            try {
              const parsed = JSON.parse(raw);
              if (typeof parsed?.seq === 'number' && parsed.seq <= maxReplayedSeq) continue;
            } catch {
              // ignore
            }
            ws.send(raw);
          }
        }
      });
    } catch {
      socket.destroy();
    }
  });

  return async () => {
    clearInterval(heartbeat);
    for (const client of wss.clients) {
      client.close();
    }
    wss.close();
    await sub.quit().catch(() => sub.disconnect());
  };
}
