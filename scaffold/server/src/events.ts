import crypto from 'node:crypto';
import { collections } from './db.js';
import { getRedis } from './redis.js';

async function withWorkspaceEmitLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const lockKey = `lock:emit:${workspace}`;
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const ok = await redis.set(lockKey, token, 'PX', 3000, 'NX');
    if (ok === 'OK') {
      try {
        return await fn();
      } finally {
        const cur = await redis.get(lockKey);
        if (cur === token) await redis.del(lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, 8));
  }
  throw new Error(`emit_lock_timeout:${workspace}`);
}

/**
 * Persists a workspace event with a durable MongoDB sequence number BEFORE publishing
 * to Redis Pub/Sub. Serialized per workspace so live WebSocket frames arrive in strictly
 * increasing `seq` order, and idempotent when `dedupeKey` is supplied.
 */
export async function emitWorkspaceEvent(
  workspace: string,
  type: string,
  fields: Record<string, unknown>,
  dedupeKey?: string
): Promise<Record<string, unknown>> {
  return withWorkspaceEmitLock(workspace, async () => {
    const { counters, events } = await collections();
    const redis = getRedis();

    if (dedupeKey) {
      const existing = await events.findOne({ workspace, dedupeKey });
      if (existing) return existing.payload;
    }

    const counter = await counters.findOneAndUpdate(
      { _id: workspace },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    const seq = counter?.seq ?? 1;
    const frame = { seq, type, ...fields };

    await events.insertOne({
      workspace,
      seq,
      type,
      ...(dedupeKey ? { dedupeKey } : {}),
      payload: frame,
      createdAt: new Date(),
    });

    await redis.publish(`ws:${workspace}`, JSON.stringify(frame));
    return frame;
  });
}
