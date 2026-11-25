import { Redis } from 'ioredis';
import { config } from './config.js';

let redis: Redis | undefined;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  }
  return redis;
}

export function createRedisSubscriber(): Redis {
  return new Redis(config.redisUrl, { lazyConnect: false, maxRetriesPerRequest: null });
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit().catch(() => redis?.disconnect());
    redis = undefined;
  }
}
