import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { after, beforeEach } from 'node:test';
import express from 'express';
import { claimConversation } from './conversations.js';
import { closeDb, collections } from './db.js';
import { handlePigeonWebhook, isKnownWorkspace } from './pigeon.js';
import { closeRedis, getRedis } from './redis.js';
import { config } from './config.js';

function signBody(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', config.pigeon.webhookSecret).update(`${t}.`).update(body).digest('hex');
  return `t=${t},v1=${v1}`;
}

async function postWebhook(payload: unknown): Promise<number> {
  const app = express();
  app.post('/webhooks/pigeon', express.raw({ type: '*/*' }), (req, res, next) => {
    handlePigeonWebhook(req, res).catch(next);
  });
  const srv = app.listen(0);
  const addr = srv.address() as { port: number };
  try {
    const raw = JSON.stringify(payload);
    const res = await fetch(`http://127.0.0.1:${addr.port}/webhooks/pigeon`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pigeon-signature': signBody(raw) },
      body: raw,
    });
    return res.status;
  } finally {
    srv.close();
  }
}

beforeEach(async () => {
  const { conversations, messages, events, counters } = await collections();
  await Promise.all([
    conversations.deleteMany({}),
    messages.deleteMany({}),
    events.deleteMany({}),
    counters.deleteMany({}),
  ]);
  const redis = getRedis();
  const keys = [...(await redis.keys('seq:*')), ...(await redis.keys('lock:*'))];
  if (keys.length) await redis.del(...keys);
});

after(async () => {
  await closeDb();
  await closeRedis();
});

test('isKnownWorkspace rejects prototype properties like constructor and toString', () => {
  assert.equal(isKnownWorkspace('ws_acme'), true);
  assert.equal(isKnownWorkspace('constructor'), false);
  assert.equal(isKnownWorkspace('toString'), false);
  assert.equal(isKnownWorkspace('__proto__'), false);
});

test('claimConversation allows only 1 winner out of 6 concurrent claims', async () => {
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      claimConversation({ workspace: 'ws_acme', contact: '+14155550199', agent: `agent_${i}` })
    )
  );
  const winners = results.filter((r) => r.ok);
  const conflicts = results.filter((r) => !r.ok && r.status === 409);
  assert.equal(winners.length, 1);
  assert.equal(conflicts.length, 5);
});

test('inbound webhook deduplicates and preserves newest lastMessageText on out-of-order delivery', async () => {
  const newer = {
    id: 'evt_2',
    type: 'message.inbound',
    workspace: 'ws_acme',
    occurred_at: '2026-11-25T12:05:00.000Z',
    data: { message_id: 'pmsg_new', from: '+14155550101', text: 'Newest message' },
  };
  const older = {
    id: 'evt_1',
    type: 'message.inbound',
    workspace: 'ws_acme',
    occurred_at: '2026-11-25T12:00:00.000Z',
    data: { message_id: 'pmsg_old', from: '+14155550101', text: 'Older late message' },
  };

  assert.equal(await postWebhook(newer), 200);
  // Duplicate delivery of newer
  assert.equal(await postWebhook(newer), 200);
  // Out-of-order older delivery arrives later
  assert.equal(await postWebhook(older), 200);

  const { conversations, messages, events } = await collections();
  const conv = await conversations.findOne({ workspace: 'ws_acme', contact: '+14155550101' });
  const msgs = await messages.find({ workspace: 'ws_acme', contact: '+14155550101' }).sort({ occurredAt: 1 }).toArray();
  const evs = await events.find({ workspace: 'ws_acme' }).sort({ seq: 1 }).toArray();

  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].pigeonMessageId, 'pmsg_old');
  assert.equal(msgs[1].pigeonMessageId, 'pmsg_new');
  assert.equal(conv?.lastMessageText, 'Newest message');
  assert.equal(evs.length, 2);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2]);
});
