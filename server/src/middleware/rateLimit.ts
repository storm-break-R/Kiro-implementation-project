import type { Redis } from 'ioredis';
import type { RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { RedisHandle } from '../infra/redis.js';

export interface LimitConfig {
  windowMs: number;
  limit: number;
}

export interface Limits {
  /** login, refresh, MFA */
  auth: LimitConfig;
  /** voter registration (code guessing protection) */
  register: LimitConfig;
  /** vote submission */
  vote: LimitConfig;
  /** all other API traffic */
  general: LimitConfig;
}

export const DEFAULT_LIMITS: Limits = {
  auth: { windowMs: 15 * 60_000, limit: 20 },
  register: { windowMs: 15 * 60_000, limit: 10 },
  vote: { windowMs: 60_000, limit: 10 },
  general: { windowMs: 60_000, limit: 300 },
};

/**
 * Shared Redis store when a real Redis is configured (so limits hold across instances),
 * otherwise express-rate-limit's in-process memory store.
 */
export function createLimiter(name: string, config: LimitConfig, redis: RedisHandle): RequestHandler {
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests, slow down' } },
    ...(redis.kind === 'redis'
      ? {
          store: new RedisStore({
            prefix: `rl:${name}:`,
            sendCommand: (command: string, ...args: string[]) =>
              (redis.client as Redis).call(command, ...args) as Promise<never>,
          }),
        }
      : {}),
  });
}
