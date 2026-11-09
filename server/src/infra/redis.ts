import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';

export interface RedisHandle {
  client: Redis;
  /** 'redis' when connected to a real server, 'memory' for the in-process fallback. */
  kind: 'redis' | 'memory';
}

/**
 * Real Redis when a URL is provided, otherwise an in-memory ioredis-compatible
 * implementation. The in-memory mode is single-process and non-persistent, which
 * is fine for local development and tests.
 */
export function createRedis(url?: string): RedisHandle {
  if (url) {
    return { client: new Redis(url, { maxRetriesPerRequest: 2 }), kind: 'redis' };
  }
  // ioredis-mock shares data between instances that have the same host:port, so give every
  // instance a unique host to keep them isolated.
  const client = new RedisMock({ host: `memory-${randomUUID()}` }) as unknown as Redis;
  return { client, kind: 'memory' };
}
