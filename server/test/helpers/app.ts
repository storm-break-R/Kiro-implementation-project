import type { Express } from 'express';
import type { Types } from 'mongoose';
import { generateSync } from 'otplib';
import request from 'supertest';
import { createApp, type AppDeps } from '../../src/app.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createRedis, type RedisHandle } from '../../src/infra/redis.js';
import { MemoryStorage } from '../../src/infra/storage.js';
import { Candidate } from '../../src/models/candidate.js';
import { EligibleVoter } from '../../src/models/eligibleVoter.js';
import { VotingEvent } from '../../src/models/event.js';
import { User } from '../../src/models/user.js';
import { hashNationalId } from '../../src/utils/crypto.js';
import { AuthService } from '../../src/services/auth.js';
import { SessionService } from '../../src/services/sessions.js';

const HIGH = { windowMs: 60_000, limit: 100_000 };
export const NO_LIMITS = { auth: HIGH, register: HIGH, vote: HIGH, general: HIGH };

export interface TestContext {
  app: Express;
  env: Env;
  redis: RedisHandle;
  storage: MemoryStorage;
}

export function buildTestApp(overrides: Partial<AppDeps> = {}, envOverrides: Record<string, string> = {}): TestContext {
  const env = loadEnv({ NODE_ENV: 'test', ...envOverrides });
  const redis = createRedis(undefined);
  const storage = new MemoryStorage();
  const app = createApp({
    env,
    redis,
    storage,
    healthChecks: [],
    limits: NO_LIMITS,
    ...overrides,
  });
  return { app, env, redis, storage };
}

export const ADMIN_PASSWORD = 'correct-horse-battery';

export async function createAdminUser(ctx: TestContext, email = 'admin@example.com') {
  const auth = new AuthService(ctx.env, ctx.redis.client, new SessionService(ctx.redis.client, ctx.env));
  const user = new User({
    email,
    passwordHash: await auth.hashPassword(ADMIN_PASSWORD),
    role: 'admin',
  });
  return user.save();
}

export interface Session {
  accessToken: string;
  refreshToken: string;
}

export function totp(secret: string, offsetSeconds = 0): string {
  return generateSync({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSeconds });
}

/** Create an admin, log in, enroll TOTP, and return a fully authenticated admin session. */
export async function enrolledAdmin(ctx: TestContext, email = 'admin@example.com') {
  await createAdminUser(ctx, email);
  const login = await request(ctx.app).post('/api/auth/login').send({ email, password: ADMIN_PASSWORD });
  const setup = await request(ctx.app)
    .post('/api/auth/mfa/setup')
    .set('Authorization', `Bearer ${login.body.accessToken}`);
  if (setup.status !== 200) {
    throw new Error(`mfa setup failed: ${setup.status} ${JSON.stringify(setup.body)}`);
  }
  const secret: string = setup.body.secret;
  const verify = await request(ctx.app)
    .post('/api/auth/mfa/verify')
    .set('Authorization', `Bearer ${login.body.accessToken}`)
    .send({ code: totp(secret) });
  return { secret, session: verify.body as Session, email };
}

export const bearer = (s: Session | string) => `Bearer ${typeof s === 'string' ? s : s.accessToken}`;

/** Insert an event directly (bypasses the API) for tests that focus on other behavior. */
export async function createEvent(
  adminId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
) {
  const event = new VotingEvent({
    title: 'Player of the Season',
    status: 'open',
    startsAt: new Date(Date.now() - 3600_000),
    endsAt: new Date(Date.now() + 3600_000),
    createdBy: adminId,
    ...overrides,
  });
  return event.save();
}

export async function createCandidates(eventId: Types.ObjectId, names = ['Messi', 'Ronaldo']) {
  return Candidate.insertMany(names.map((name) => ({ eventId, name })));
}

export const VOTER_PASSWORD = 'voter-password-123';

/** Insert a registered voter (user + eligible row) for an event, bypassing the registration API. */
export async function createRegisteredVoter(
  ctx: TestContext,
  eventId: Types.ObjectId,
  opts: { email?: string; nationalId?: string; dateOfBirth?: Date } = {},
) {
  const email = opts.email ?? 'voter@example.com';
  const nationalId = opts.nationalId ?? 'NID-0001';
  const auth = new AuthService(ctx.env, ctx.redis.client, new SessionService(ctx.redis.client, ctx.env));
  const user = await new User({
    email,
    passwordHash: await auth.hashPassword(VOTER_PASSWORD),
    role: 'voter',
  }).save();
  const row = await new EligibleVoter({
    eventId,
    fullName: 'Test Voter',
    nationalIdHash: hashNationalId(nationalId, ctx.env.CODE_PEPPER),
    nationalIdLast4: nationalId.slice(-4),
    dateOfBirth: opts.dateOfBirth ?? new Date('1990-01-01'),
    email,
    userId: user._id,
    registeredAt: new Date(),
  }).save();
  user.eligibleVoterIds = [row._id];
  await user.save();
  return { user, row, email, password: VOTER_PASSWORD };
}

export async function loginAs(ctx: TestContext, email: string, password: string): Promise<Session> {
  const res = await request(ctx.app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Session;
}
