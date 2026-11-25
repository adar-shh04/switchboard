import crypto from 'node:crypto';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';

export interface WorkspaceClaim {
  id: string;
  role: 'admin' | 'agent';
}

export interface SessionUser {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceClaim[];
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

const SESSION_COOKIE = 'sb_sid';
const SESSION_TTL_SEC = 3600 * 12;

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

let cachedDiscovery: OidcDiscovery | undefined;

async function getDiscovery(): Promise<OidcDiscovery> {
  if (cachedDiscovery) return cachedDiscovery;
  const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  cachedDiscovery = (await res.json()) as OidcDiscovery;
  return cachedDiscovery;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export async function getSessionFromCookieHeader(cookieHeader: string | undefined): Promise<SessionUser | null> {
  const cookies = parseCookies(cookieHeader);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const raw = await getRedis().get(`sess:${sid}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getSessionFromCookieHeader(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next();
}

export function getWorkspaceRole(user: SessionUser, workspace: string): 'admin' | 'agent' | null {
  const found = user.workspaces.find((w) => w.id === workspace);
  return found ? found.role : null;
}

export function createAuthRouter(): Router {
  const router = express.Router();

  router.get('/auth/login', async (_req, res) => {
    try {
      const discovery = await getDiscovery();
      const state = crypto.randomBytes(16).toString('hex');
      const nonce = crypto.randomBytes(16).toString('hex');
      const verifier = crypto.randomBytes(32).toString('base64url');
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

      await getRedis().setex(
        `oidc:${state}`,
        600,
        JSON.stringify({ verifier, nonce })
      );

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set('client_id', config.oidc.clientId);
      authUrl.searchParams.set('redirect_uri', config.oidc.redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'openid profile email');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('nonce', nonce);
      authUrl.searchParams.set('code_challenge', challenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');

      res.redirect(302, authUrl.toString());
    } catch (err) {
      res.status(502).json({ error: 'oidc_unavailable', detail: String(err) });
    }
  });

  router.get('/auth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      res.status(400).json({ error: 'missing_code_or_state' });
      return;
    }

    const redis = getRedis();
    const pendingRaw = await redis.get(`oidc:${state}`);
    if (!pendingRaw) {
      res.status(400).json({ error: 'invalid_or_expired_state' });
      return;
    }
    await redis.del(`oidc:${state}`);
    const pending = JSON.parse(pendingRaw) as { verifier: string; nonce: string };

    try {
      const discovery = await getDiscovery();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.oidc.redirectUri,
        client_id: config.oidc.clientId,
        client_secret: config.oidc.clientSecret,
        code_verifier: pending.verifier,
      });

      const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(5000),
      });
      if (!tokenRes.ok) {
        const txt = await tokenRes.text();
        res.status(401).json({ error: 'token_exchange_failed', detail: txt });
        return;
      }

      const tokens = (await tokenRes.json()) as { access_token?: string; id_token?: string };
      let user: SessionUser | null = null;

      if (tokens.access_token) {
        const uiRes = await fetch(discovery.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (uiRes.ok) {
          user = (await uiRes.json()) as SessionUser;
        }
      }

      if (!user && tokens.id_token) {
        const parts = tokens.id_token.split('.');
        if (parts.length === 3) {
          const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
          if (claims.nonce && claims.nonce !== pending.nonce) {
            res.status(401).json({ error: 'invalid_nonce' });
            return;
          }
          user = {
            sub: claims.sub,
            name: claims.name,
            email: claims.email,
            workspaces: Array.isArray(claims.workspaces) ? claims.workspaces : [],
          };
        }
      }

      if (!user || !user.sub) {
        res.status(401).json({ error: 'invalid_user_claims' });
        return;
      }

      const sid = crypto.randomBytes(24).toString('hex');
      await redis.setex(`sess:${sid}`, SESSION_TTL_SEC, JSON.stringify(user));

      res.setHeader(
        'Set-Cookie',
        `${SESSION_COOKIE}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SEC}`
      );
      res.redirect(302, config.webOrigin);
    } catch (err) {
      res.status(502).json({ error: 'oidc_callback_error', detail: String(err) });
    }
  });

  router.post('/auth/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const sid = cookies[SESSION_COOKIE];
    if (sid) await getRedis().del(`sess:${sid}`);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/api/me', requireAuth, (req, res) => {
    res.json({
      sub: req.user!.sub,
      name: req.user!.name,
      email: req.user!.email,
      workspaces: req.user!.workspaces,
    });
  });

  return router;
}
