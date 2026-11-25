import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { collections, type MessageDoc, type OutboundStatus } from './db.js';
import { emitWorkspaceEvent } from './events.js';
import { getRedis } from './redis.js';

const INSTANCE_ID = `srv_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
const LEASE_MS = 20_000;
const HTTP_TIMEOUT_MS = 14_000;

const STATUS_RANK: Record<OutboundStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  failed: 3,
};

function verifyPigeonSignature(header: string | undefined, rawBody: Buffer): boolean {
  if (!header || typeof header !== 'string') return false;
  let tStr = '';
  let v1 = '';
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') tStr = v;
    else if (k === 'v1') v1 = v;
  }
  if (!tStr || !v1 || !/^\d+$/.test(tStr) || !/^[0-9a-f]+$/i.test(v1)) return false;

  const t = Number(tStr);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > 300) return false;

  const expected = crypto
    .createHmac('sha256', config.pigeon.webhookSecret)
    .update(`${tStr}.`)
    .update(rawBody)
    .digest('hex');

  const a = Buffer.from(v1.toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function handlePigeonWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const sigHeader = req.headers['x-pigeon-signature'];
  if (!verifyPigeonSignature(typeof sigHeader === 'string' ? sigHeader : undefined, rawBody)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    res.status(400).json({ error: 'invalid_payload' });
    return;
  }

  const workspace = typeof event.workspace === 'string' ? event.workspace : '';
  if (!workspace || !(workspace in config.pigeon.apiKeys)) {
    // Unknown workspace: acknowledge 2xx and ignore per PIGEON.md
    res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
    return;
  }

  const { conversations, messages } = await collections();
  const now = new Date();

  if (event.type === 'message.inbound') {
    const data = event.data || {};
    const messageId = typeof data.message_id === 'string' ? data.message_id : '';
    const from = typeof data.from === 'string' ? data.from : '';
    const text = typeof data.text === 'string' ? data.text : '';
    const occurredAt = event.occurred_at ? new Date(event.occurred_at) : now;

    if (!messageId || !from || Number.isNaN(occurredAt.getTime())) {
      res.status(400).json({ error: 'invalid_inbound_data' });
      return;
    }

    const upsertMsg = await messages.updateOne(
      { workspace, pigeonMessageId: messageId },
      {
        $setOnInsert: {
          workspace,
          contact: from,
          direction: 'inbound',
          text,
          occurredAt,
          pigeonEventId: typeof event.id === 'string' ? event.id : undefined,
          pigeonMessageId: messageId,
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true }
    );

    if (upsertMsg.upsertedCount > 0) {
      await conversations.updateOne(
        { workspace, contact: from },
        {
          $setOnInsert: {
            workspace,
            contact: from,
            assignee: null,
            status: 'open',
          },
          $max: { lastMessageAt: occurredAt },
          $set: { lastMessageText: text, updatedAt: now },
        },
        { upsert: true }
      );

      await emitWorkspaceEvent(workspace, 'message.inbound', {
        contact: from,
        message_id: messageId,
        text,
        occurred_at: occurredAt.toISOString(),
      });
    }

    res.status(200).json({ ok: true });
    return;
  }

  if (event.type === 'message.status') {
    const data = event.data || {};
    const clientRef = typeof data.client_ref === 'string' ? data.client_ref : '';
    const nextStatus = typeof data.status === 'string' ? (data.status as OutboundStatus) : null;
    if (!clientRef || !nextStatus || !(nextStatus in STATUS_RANK)) {
      res.status(200).json({ ok: true, ignored: 'invalid_status' });
      return;
    }

    const existing = await messages.findOne({ workspace, direction: 'outbound', clientRef });
    if (!existing) {
      // Status for a message we never sent: 2xx and ignore per PIGEON.md
      res.status(200).json({ ok: true, ignored: 'unknown_message' });
      return;
    }

    const allowedPrev: OutboundStatus[] =
      nextStatus === 'sent'
        ? ['queued', 'sending']
        : nextStatus === 'delivered' || nextStatus === 'failed'
          ? ['queued', 'sending', 'sent']
          : [];

    if (allowedPrev.length > 0) {
      const upd = await messages.findOneAndUpdate(
        { _id: existing._id, status: { $in: allowedPrev } },
        {
          $set: {
            status: nextStatus,
            pigeonMessageId: typeof data.message_id === 'string' ? data.message_id : existing.pigeonMessageId,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' }
      );

      if (upd) {
        await emitWorkspaceEvent(workspace, 'message.status', {
          contact: upd.contact,
          client_ref: clientRef,
          status: nextStatus,
        });
      }
    }

    res.status(200).json({ ok: true });
    return;
  }

  // Unknown event type: 2xx per PIGEON.md
  res.status(200).json({ ok: true, ignored: 'unknown_type' });
}

export async function enqueueOutboundReply(params: {
  workspace: string;
  contact: string;
  text: string;
  clientRef: string;
}): Promise<{ ok: true; clientRef: string }> {
  const { workspace, contact, text, clientRef } = params;
  if (!(workspace in config.pigeon.apiKeys)) {
    const err = new Error(`Unknown workspace: ${workspace}`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }

  const { conversations, messages } = await collections();
  const now = new Date();

  await conversations.updateOne(
    { workspace, contact },
    {
      $setOnInsert: {
        workspace,
        contact,
        assignee: null,
        status: 'open',
      },
      $max: { lastMessageAt: now },
      $set: { lastMessageText: text, updatedAt: now },
    },
    { upsert: true }
  );

  await messages.updateOne(
    { workspace, clientRef },
    {
      $setOnInsert: {
        workspace,
        contact,
        direction: 'outbound',
        text,
        occurredAt: now,
        clientRef,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        leaseOwner: null,
        leaseUntil: null,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  wakeWorker();
  return { ok: true, clientRef };
}

// Atomic Redis token bucket + shared cool-off check.
// Returns 0 if allowed to send now, or positive delay in ms to wait.
const RATE_LIMIT_LUA = `
local coolKey = KEYS[1]
local tbKey = KEYS[2]
local nowMs = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillPerMs = tonumber(ARGV[3])

local coolUntil = tonumber(redis.call('GET', coolKey) or '0')
if coolUntil > nowMs then
  return coolUntil - nowMs
end

local data = redis.call('HMGET', tbKey, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if not tokens or not ts then
  tokens = capacity
  ts = nowMs
else
  local elapsed = math.max(0, nowMs - ts)
  tokens = math.min(capacity, tokens + elapsed * refillPerMs)
  ts = nowMs
end

if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HMSET', tbKey, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', tbKey, 10000)
  return 0
else
  redis.call('HMSET', tbKey, 'tokens', tokens, 'ts', ts)
  redis.call('PEXPIRE', tbKey, 10000)
  local waitMs = math.ceil((1 - tokens) / refillPerMs)
  return math.max(50, waitMs)
end
`;

async function acquireSendSlot(workspace: string): Promise<number> {
  const redis = getRedis();
  const delay = await redis.eval(
    RATE_LIMIT_LUA,
    2,
    `pigeon:cooloff:${workspace}`,
    `pigeon:tb:${workspace}`,
    String(Date.now()),
    '7',
    String(3.5 / 1000)
  );
  return Number(delay) || 0;
}

async function setSharedCooloff(workspace: string, delayMs: number): Promise<void> {
  const redis = getRedis();
  const key = `pigeon:cooloff:${workspace}`;
  const target = Date.now() + delayMs;
  const current = Number((await redis.get(key)) || '0');
  if (target > current) {
    await redis.set(key, String(target), 'PX', Math.max(100, delayMs + 500));
  }
}

async function processOneMessage(msg: MessageDoc & { _id: any }): Promise<void> {
  const { messages } = await collections();
  const apiKey = config.pigeon.apiKeys[msg.workspace];
  if (!apiKey) {
    await messages.updateOne(
      { _id: msg._id },
      { $set: { status: 'failed', lastError: 'missing_api_key', leaseOwner: null, leaseUntil: null, updatedAt: new Date() } }
    );
    return;
  }

  const waitMs = await acquireSendSlot(msg.workspace);
  if (waitMs > 0) {
    await messages.updateOne(
      { _id: msg._id, leaseOwner: INSTANCE_ID },
      { $set: { nextAttemptAt: new Date(Date.now() + waitMs), leaseOwner: null, leaseUntil: null, updatedAt: new Date() } }
    );
    return;
  }

  try {
    const res = await fetch(`${config.pigeon.url}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        'idempotency-key': msg.clientRef || String(msg._id),
      },
      body: JSON.stringify({
        to: msg.contact,
        text: msg.text,
        client_ref: msg.clientRef,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });

    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      const now = new Date();
      const upd = await messages.findOneAndUpdate(
        { _id: msg._id, status: { $in: ['queued', 'sending'] } },
        {
          $set: {
            status: 'sent',
            pigeonMessageId: data.id || msg.pigeonMessageId,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: now,
          },
        },
        { returnDocument: 'after' }
      );
      if (upd) {
        await emitWorkspaceEvent(msg.workspace, 'message.status', {
          contact: msg.contact,
          client_ref: msg.clientRef,
          status: 'sent',
        });
      } else {
        await messages.updateOne({ _id: msg._id }, { $set: { leaseOwner: null, leaseUntil: null } });
      }
      return;
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('retry-after') || '1');
      const delayMs = Math.max(250, Math.ceil((Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000) + 150);
      await setSharedCooloff(msg.workspace, delayMs);
      await messages.updateOne(
        { _id: msg._id },
        {
          $set: {
            nextAttemptAt: new Date(Date.now() + delayMs),
            leaseOwner: null,
            leaseUntil: null,
            lastError: 'rate_limited_429',
            updatedAt: new Date(),
          },
          $inc: { attempts: 1 },
        }
      );
      return;
    }

    // 503 or other transient error: back off shared across instances
    const attempts = (msg.attempts || 0) + 1;
    const backoffMs = Math.min(5000, 1000 * Math.pow(2, Math.min(attempts - 1, 2)));
    if (res.status >= 500) {
      await setSharedCooloff(msg.workspace, Math.min(2500, backoffMs));
    }
    await messages.updateOne(
      { _id: msg._id },
      {
        $set: {
          nextAttemptAt: new Date(Date.now() + backoffMs),
          leaseOwner: null,
          leaseUntil: null,
          lastError: `http_${res.status}`,
          updatedAt: new Date(),
        },
        $inc: { attempts: 1 },
      }
    );
  } catch (err) {
    // Timeout or network error: release lease and retry with Idempotency-Key
    const attempts = (msg.attempts || 0) + 1;
    const backoffMs = Math.min(5000, 1000 * Math.pow(2, Math.min(attempts - 1, 2)));
    await messages.updateOne(
      { _id: msg._id },
      {
        $set: {
          nextAttemptAt: new Date(Date.now() + backoffMs),
          leaseOwner: null,
          leaseUntil: null,
          lastError: String(err),
          updatedAt: new Date(),
        },
        $inc: { attempts: 1 },
      }
    );
  }
}

let workerRunning = false;
let workerTimer: NodeJS.Timeout | undefined;
let pumping = false;

async function pumpOutbound(): Promise<void> {
  if (!workerRunning || pumping) return;
  pumping = true;
  try {
    const { messages } = await collections();
    const inFlight: Promise<void>[] = [];
    const MAX_CONCURRENCY = 6;

    while (workerRunning && inFlight.length < MAX_CONCURRENCY) {
      const now = new Date();
      const doc = await messages.findOneAndUpdate(
        {
          direction: 'outbound',
          status: { $in: ['queued', 'sending'] },
          nextAttemptAt: { $lte: now },
          $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
        },
        {
          $set: {
            status: 'sending',
            leaseOwner: INSTANCE_ID,
            leaseUntil: new Date(now.getTime() + LEASE_MS),
            updatedAt: now,
          },
        },
        { sort: { nextAttemptAt: 1, createdAt: 1 }, returnDocument: 'after' }
      );

      if (!doc) break;
      inFlight.push(processOneMessage(doc as MessageDoc & { _id: any }));
    }

    if (inFlight.length > 0) {
      await Promise.allSettled(inFlight);
    }
  } catch {
    // ignore transient DB errors during reset/shutdown
  } finally {
    pumping = false;
  }
}

export function wakeWorker(): void {
  if (workerRunning) {
    void pumpOutbound();
  }
}

export function startOutboundWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  workerTimer = setInterval(() => {
    void pumpOutbound();
  }, 250);
  void pumpOutbound();
}

export function stopOutboundWorker(): void {
  workerRunning = false;
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = undefined;
  }
}
