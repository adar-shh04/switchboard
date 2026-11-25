import { collections } from './db.js';
import { getRedis } from './redis.js';

const EMIT_LUA = `
local seq = redis.call('INCR', KEYS[1])
local frame = '{"seq":' .. seq .. ',' .. ARGV[1]
redis.call('PUBLISH', KEYS[2], frame)
return seq
`;

export async function emitWorkspaceEvent(
  workspace: string,
  type: string,
  fields: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const redis = getRedis();
  const bodyJson = JSON.stringify({ type, ...fields }).slice(1); // strip leading '{'
  const seq = Number(
    await redis.eval(EMIT_LUA, 2, `seq:${workspace}`, `ws:${workspace}`, bodyJson)
  );
  const frame = { seq, type, ...fields };

  const { events } = await collections();
  await events.insertOne({
    workspace,
    seq,
    type,
    payload: frame,
    createdAt: new Date(),
  });

  return frame;
}
