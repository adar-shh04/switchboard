import crypto from 'node:crypto';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { getWorkspaceRole, requireAuth } from './auth.js';
import {
  cancelWorkspaceSubscription,
  canWorkspaceSend,
  getWorkspaceBilling,
  subscribeWorkspace,
  updateWorkspaceSeats,
} from './billing.js';
import { config } from './config.js';
import { claimConversation, releaseConversation, setConversationStatus } from './conversations.js';
import { collections } from './db.js';
import { enqueueOutboundReply, isKnownWorkspace } from './pigeon.js';
import { getRedis } from './redis.js';

function asNonEmptyString(val: unknown): string | null {
  return typeof val === 'string' && val.length > 0 ? val : null;
}

function asPositiveInt(val: unknown): number | null {
  return typeof val === 'number' && Number.isInteger(val) && val >= 1 ? val : null;
}

function parsePaging(
  limitQ: unknown,
  offsetQ: unknown,
  defaultLimit: number,
  maxLimit: number
): { limit: number; offset: number } {
  const rawLim = typeof limitQ === 'string' && limitQ !== '' ? Number(limitQ) : defaultLimit;
  const rawOff = typeof offsetQ === 'string' && offsetQ !== '' ? Number(offsetQ) : 0;
  const limit = Number.isFinite(rawLim) ? Math.min(maxLimit, Math.max(1, Math.trunc(rawLim))) : defaultLimit;
  const offset = Number.isFinite(rawOff) ? Math.max(0, Math.trunc(rawOff)) : 0;
  return { limit, offset };
}

function requireGrader(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers['x-grader-token'];
  if (token !== config.graderToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

export function createApiRouter(): Router {
  const router = express.Router();

  // ---------------- Grader endpoints ----------------
  router.post('/__grader/reset', requireGrader, async (_req, res) => {
    const { conversations, messages, events, counters, notes, billing } = await collections();
    await Promise.all([
      conversations.deleteMany({}),
      messages.deleteMany({}),
      events.deleteMany({}),
      counters.deleteMany({}),
      notes.deleteMany({}),
      billing.deleteMany({}),
    ]);

    const redis = getRedis();
    const keysToDelete = [
      ...(await redis.keys('seq:*')),
      ...(await redis.keys('pigeon:*')),
      ...(await redis.keys('lock:*')),
    ];
    if (keysToDelete.length > 0) {
      await redis.del(...keysToDelete);
    }

    res.json({ ok: true });
  });

  router.get('/__grader/snapshot', requireGrader, async (_req, res) => {
    const { conversations, messages, billing } = await collections();
    const [convs, msgs, bills] = await Promise.all([
      conversations.find({}).toArray(),
      messages.find({}).sort({ occurredAt: 1, _id: 1 }).toArray(),
      billing.find({}).toArray(),
    ]);

    const workspaces: Record<
      string,
      {
        contacts: Record<string, { inbound: string[]; assignee: string | null }>;
        outbound: Record<string, string>;
        billing: { status: string; seats: number; can_send: boolean };
      }
    > = {};

    const billMap = new Map(bills.map((b) => [b.workspace, b]));

    const ensureWs = (ws: string) => {
      if (!workspaces[ws]) {
        const b = billMap.get(ws);
        const status = b?.status ?? 'none';
        workspaces[ws] = {
          contacts: {},
          outbound: {},
          billing: {
            status,
            seats: b?.seats ?? 1,
            can_send: canWorkspaceSend(status),
          },
        };
      }
      return workspaces[ws];
    };

    for (const b of bills) ensureWs(b.workspace);

    for (const c of convs) {
      const ws = ensureWs(c.workspace);
      ws.contacts[c.contact] = { inbound: [], assignee: c.assignee ?? null };
    }

    for (const m of msgs) {
      const ws = ensureWs(m.workspace);
      if (m.direction === 'inbound') {
        if (!ws.contacts[m.contact]) {
          ws.contacts[m.contact] = { inbound: [], assignee: null };
        }
        if (m.pigeonMessageId) {
          ws.contacts[m.contact].inbound.push(m.pigeonMessageId);
        }
      } else if (m.direction === 'outbound' && m.clientRef) {
        ws.outbound[m.clientRef] = m.status || 'queued';
      }
    }

    res.json({ workspaces });
  });

  router.post('/__grader/reply', requireGrader, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const contact = asNonEmptyString(req.body?.contact);
    const text = typeof req.body?.text === 'string' ? req.body.text : null;
    const clientRef = asNonEmptyString(req.body?.client_ref);
    if (!workspace || !contact || text === null || !clientRef) {
      res.status(400).json({ error: 'missing_or_invalid_fields' });
      return;
    }
    if (!isKnownWorkspace(workspace)) {
      res.status(400).json({ error: 'unknown_workspace' });
      return;
    }
    const bill = await getWorkspaceBilling(workspace);
    if (!bill.can_send) {
      res.status(402).json({ error: 'subscription_inactive', status: bill.status });
      return;
    }
    try {
      await enqueueOutboundReply({ workspace, contact, text, clientRef });
      res.status(202).json({ ok: true, client_ref: clientRef });
    } catch (err: any) {
      res.status(err?.status || 400).json({ error: err?.message || 'reply_failed' });
    }
  });

  router.post('/__grader/billing/subscribe', requireGrader, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const token = asNonEmptyString(req.body?.token);
    const seats = asPositiveInt(req.body?.seats);
    if (!workspace || !token || !seats) {
      res.status(400).json({ error: 'missing_or_invalid_fields' });
      return;
    }
    if (!isKnownWorkspace(workspace)) {
      res.status(400).json({ error: 'unknown_workspace' });
      return;
    }
    const result = await subscribeWorkspace({ workspace, seats, token });
    res.status(result.statusCode).json(result);
  });

  router.post('/__grader/billing/seats', requireGrader, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const seats = asPositiveInt(req.body?.seats);
    if (!workspace || !seats) {
      res.status(400).json({ error: 'missing_or_invalid_fields' });
      return;
    }
    if (!isKnownWorkspace(workspace)) {
      res.status(400).json({ error: 'unknown_workspace' });
      return;
    }
    const result = await updateWorkspaceSeats({ workspace, seats });
    res.status(result.statusCode).json(result);
  });

  router.post('/__grader/claim', requireGrader, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const contact = asNonEmptyString(req.body?.contact);
    const agent = asNonEmptyString(req.body?.agent);
    if (!workspace || !contact || !agent) {
      res.status(400).json({ error: 'missing_or_invalid_fields' });
      return;
    }
    if (!isKnownWorkspace(workspace)) {
      res.status(400).json({ error: 'unknown_workspace' });
      return;
    }
    const result = await claimConversation({ workspace, contact, agent });
    if (!result.ok) {
      res.status(409).json({ error: 'already_claimed', assignee: result.assignee });
      return;
    }
    res.json({ ok: true, assignee: result.assignee });
  });

  // ---------------- Product API ----------------
  router.get('/api/conversations', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.query.workspace);
    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : 'all';
    const { limit, offset } = parsePaging(req.query.limit, req.query.offset, 50, 100);

    const filter: Record<string, unknown> = { workspace };
    if (status === 'open' || status === 'closed') filter.status = status;

    const { conversations } = await collections();
    const [items, total] = await Promise.all([
      conversations.find(filter).sort({ lastMessageAt: -1 }).skip(offset).limit(limit).toArray(),
      conversations.countDocuments(filter),
    ]);

    res.json({ conversations: items, total });
  });

  router.get('/api/conversations/:contact/messages', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.query.workspace);
    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const { limit, offset } = parsePaging(req.query.limit, req.query.offset, 200, 500);
    const { messages } = await collections();
    const items = await messages
      .find({ workspace, contact })
      .sort({ occurredAt: 1, _id: 1 })
      .skip(offset)
      .limit(limit)
      .toArray();
    res.json({ messages: items });
  });

  router.post('/api/conversations/:contact/claim', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const result = await claimConversation({ workspace, contact, agent: req.user!.sub });
    if (!result.ok) {
      res.status(409).json({ error: 'already_claimed', assignee: result.assignee });
      return;
    }
    res.json({ ok: true, assignee: result.assignee });
  });

  router.post('/api/conversations/:contact/release', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const role = workspace ? getWorkspaceRole(req.user!, workspace) : null;
    if (!workspace || !role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const { conversations } = await collections();
    const existing = await conversations.findOne({ workspace, contact });
    if (existing?.assignee && existing.assignee !== req.user!.sub && role !== 'admin') {
      res.status(403).json({ error: 'only_holder_or_admin_can_release', assignee: existing.assignee });
      return;
    }
    await releaseConversation({ workspace, contact });
    res.json({ ok: true });
  });

  router.post('/api/conversations/:contact/status', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const role = workspace ? getWorkspaceRole(req.user!, workspace) : null;
    const status = req.body?.status;
    if (!workspace || !role) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (status !== 'open' && status !== 'closed') {
      res.status(400).json({ error: 'invalid_status' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const { conversations } = await collections();
    const existing = await conversations.findOne({ workspace, contact });
    if (existing?.assignee && existing.assignee !== req.user!.sub && role !== 'admin') {
      res.status(403).json({ error: 'only_holder_or_admin_can_change_status', assignee: existing.assignee });
      return;
    }
    await setConversationStatus({ workspace, contact, status });
    res.json({ ok: true, status });
  });

  router.post('/api/conversations/:contact/reply', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const clientRef = asNonEmptyString(req.body?.client_ref) ?? `ui_${crypto.randomUUID()}`;

    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!text.trim()) {
      res.status(400).json({ error: 'empty_text' });
      return;
    }

    const bill = await getWorkspaceBilling(workspace);
    if (!bill.can_send) {
      res.status(402).json({ error: 'subscription_inactive', status: bill.status });
      return;
    }

    const contact = decodeURIComponent(req.params.contact);
    await enqueueOutboundReply({ workspace, contact, text, clientRef });
    res.status(202).json({ ok: true, client_ref: clientRef });
  });

  // ---------------- Billing (Admin only) ----------------
  router.get('/api/billing', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.query.workspace);
    if (!workspace || getWorkspaceRole(req.user!, workspace) !== 'admin') {
      res.status(403).json({ error: 'admin_only' });
      return;
    }
    const bill = await getWorkspaceBilling(workspace);
    res.json({
      ...bill,
      payboxUrl: config.paybox.url,
      publishableKey: config.paybox.publishableKey,
      pricePerSeatCents: 1200,
    });
  });

  router.post('/api/billing/subscribe', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const token = asNonEmptyString(req.body?.token);
    const seats = asPositiveInt(req.body?.seats ?? 1);
    if (!workspace || getWorkspaceRole(req.user!, workspace) !== 'admin') {
      res.status(403).json({ error: 'admin_only' });
      return;
    }
    if (!token || !seats) {
      res.status(400).json({ error: 'invalid_billing_params' });
      return;
    }
    const result = await subscribeWorkspace({
      workspace,
      seats,
      token,
      name: req.user!.name || workspace,
      email: req.user!.email || `billing@${workspace}.test`,
    });
    res.status(result.statusCode).json(result);
  });

  router.post('/api/billing/seats', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const seats = asPositiveInt(req.body?.seats);
    if (!workspace || getWorkspaceRole(req.user!, workspace) !== 'admin') {
      res.status(403).json({ error: 'admin_only' });
      return;
    }
    if (!seats) {
      res.status(400).json({ error: 'invalid_seats' });
      return;
    }
    const result = await updateWorkspaceSeats({ workspace, seats });
    res.status(result.statusCode).json(result);
  });

  router.post('/api/billing/cancel', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    if (!workspace || getWorkspaceRole(req.user!, workspace) !== 'admin') {
      res.status(403).json({ error: 'admin_only' });
      return;
    }
    const result = await cancelWorkspaceSubscription(workspace);
    res.json(result);
  });

  // Private notes (stored as opaque client-encrypted ciphertext)
  router.get('/api/conversations/:contact/notes', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.query.workspace);
    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const { notes } = await collections();
    const items = await notes.find({ workspace, contact }).sort({ createdAt: 1 }).toArray();
    res.json({ notes: items });
  });

  router.post('/api/conversations/:contact/notes', requireAuth, async (req, res) => {
    const workspace = asNonEmptyString(req.body?.workspace);
    const ciphertext = asNonEmptyString(req.body?.ciphertext);
    const iv = asNonEmptyString(req.body?.iv);
    if (!workspace || !getWorkspaceRole(req.user!, workspace)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    if (!ciphertext || !iv) {
      res.status(400).json({ error: 'missing_ciphertext' });
      return;
    }
    const contact = decodeURIComponent(req.params.contact);
    const { notes } = await collections();
    const doc = {
      workspace,
      contact,
      authorSub: req.user!.sub,
      authorName: req.user!.name || req.user!.sub,
      ciphertext,
      iv,
      createdAt: new Date(),
    };
    await notes.insertOne(doc);
    res.status(201).json({ note: doc });
  });

  return router;
}
