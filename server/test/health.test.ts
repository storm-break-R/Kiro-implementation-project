import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { createRedis } from '../src/infra/redis.js';
import { buildTestApp } from './helpers/app.js';

const up = async (): Promise<void> => {};
const down = async (): Promise<void> => {
  throw new Error('connection refused');
};

function build(checks: { mongo: () => Promise<void>; redis: () => Promise<void> }) {
  return buildTestApp({
    healthChecks: [
      { name: 'mongo', check: checks.mongo },
      { name: 'redis', check: checks.redis },
    ],
  }).app;
}

describe('GET /health', () => {
  it('returns 200 when mongo and redis are up', async () => {
    const res = await request(build({ mongo: up, redis: up })).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', services: { mongo: 'up', redis: 'up' } });
  });

  it('returns 503 and names the failing dependency', async () => {
    const res = await request(build({ mongo: up, redis: down })).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.services).toEqual({ mongo: 'up', redis: 'down' });
  });

  it('returns a JSON 404 for unknown routes', async () => {
    const res = await request(build({ mongo: up, redis: up })).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sets a request id header and security headers', async () => {
    const res = await request(build({ mongo: up, redis: up })).get('/health');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('in-memory redis fallback', () => {
  it('keeps separate instances isolated', async () => {
    const a = createRedis(undefined);
    const b = createRedis(undefined);
    await a.client.set('shared', '1');
    expect(await b.client.get('shared')).toBeNull();
  });

  it('is used when REDIS_URL is unset and answers ping', async () => {
    const handle = createRedis(undefined);
    expect(handle.kind).toBe('memory');
    expect(await handle.client.ping()).toBe('PONG');
    await handle.client.set('k', 'v');
    expect(await handle.client.get('k')).toBe('v');
    handle.client.disconnect();
  });
});

describe('loadEnv', () => {
  it('applies defaults and leaves optional services unset', () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(4000);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.S3_BUCKET).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    expect(loadEnv({ REDIS_URL: '', S3_BUCKET: ' ' }).REDIS_URL).toBeUndefined();
  });

  it('accepts a .env copied straight from .env.example (blank secrets use dev defaults)', () => {
    const env = loadEnv({ JWT_SECRET: '', CODE_PEPPER: '', ENCRYPTION_KEY: '', PORT: '', ADMIN_EMAIL: '' });
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.PORT).toBe(4000);
    expect(env.ADMIN_EMAIL).toBeUndefined();
  });

  it('still refuses blank secrets in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production', JWT_SECRET: '' })).toThrow(/unique secret/);
  });

  it('rejects invalid values', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/Invalid environment/);
  });
});
