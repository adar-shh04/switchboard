import { collections } from './db.js';
import { getRedis } from './redis.js';

export async function emitWorkspaceEvent(
  workspace: string,
  type: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const redis = getRedis();
  const seq = await redis.incr(`seq:${workspace}`);
  const frame = { seq, type, ...fields };

  const { events } = await collections();
  await events.insertOne({
    workspace,
    seq,
    type,
    payload: frame,
    createdAt: new Date(),
  });

  await redis.publish(`ws:${workspace}`, JSON.stringify(frame));
  return frame;
}
