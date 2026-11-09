import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { User } from '../src/models/user.js';
import { verifyAuditChain } from '../src/services/audit.js';
import {
  ADMIN_PASSWORD,
  bearer,
  buildTestApp,
  createAdminUser,
  createEvent,
  createRegisteredVoter,
  enrolledAdmin,
  totp,
  type TestContext,
} from './helpers/app.js';
import { clearCollections, connectTestDb, disconnectTestDb } from './helpers/db.js';

let ctx: TestContext;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearCollections();
  ctx = buildTestApp();
});

const login = (body: Record<string, unknown>) => request(ctx.app).post('/api/auth/login').send(body);

describe('admin login and MFA enrollment', () => {
  it('lets a not-yet-enrolled admin in only to enroll, not to use admin routes', async () => {
    await createAdminUser(ctx);
    const res = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.mfaEnrollmentRequired).toBe(true);

    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(res.body));
    expect(ping.status).toBe(403);
    expect(ping.body.error.code).toBe('MFA_REQUIRED');
  });

  it('enrolls TOTP, upgrades the session, and stores the secret encrypted', async () => {
    const { secret, session } = await enrolledAdmin(ctx);
    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(session));
    expect(ping.status).toBe(200);

    const user = await User.findOne({ email: 'admin@example.com' }).lean();
    expect(user!.totpEnabled).toBe(true);
    expect(user!.totpSecretEnc).toBeTruthy();
    expect(user!.totpSecretEnc).not.toContain(secret);
  });

  it('rejects a wrong enrollment code and does not enable MFA', async () => {
    await createAdminUser(ctx);
    const l = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD });
    await request(ctx.app).post('/api/auth/mfa/setup').set('Authorization', bearer(l.body));
    const res = await request(ctx.app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', bearer(l.body))
      .send({ code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_MFA_CODE');
    expect((await User.findOne({ email: 'admin@example.com' }))!.totpEnabled).toBe(false);
  });

  it('requires the TOTP code at login once enrolled', async () => {
    const { secret } = await enrolledAdmin(ctx);

    const noCode = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body.error.code).toBe('MFA_REQUIRED');

    const bad = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD, totpCode: '123456' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_CREDENTIALS');

    // Enrollment consumed the current code; use the next window's code (inside the tolerance).
    const code = totp(secret, 30);
    const ok = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD, totpCode: code });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaEnrollmentRequired).toBe(false);
    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(ok.body));
    expect(ping.status).toBe(200);
  });

  it('does not accept a TOTP code twice (replay protection)', async () => {
    const { secret } = await enrolledAdmin(ctx);
    const code = totp(secret, 30);
    const first = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD, totpCode: code });
    expect(first.status).toBe(200);
    const replay = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD, totpCode: code });
    expect(replay.status).toBe(401);
  });

  it('refuses to set up MFA twice', async () => {
    const { session } = await enrolledAdmin(ctx);
    const res = await request(ctx.app).post('/api/auth/mfa/setup').set('Authorization', bearer(session));
    expect(res.status).toBe(409);
  });
});

describe('credential handling', () => {
  it('gives the same error for a wrong password and an unknown email', async () => {
    await createAdminUser(ctx);
    const wrong = await login({ email: 'admin@example.com', password: 'nope-nope-nope' });
    const unknown = await login({ email: 'ghost@example.com', password: 'nope-nope-nope' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
    expect(wrong.body.error.code).toBe(unknown.body.error.code);
  });

  it('validates input shape', async () => {
    const res = await login({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('locks the account after repeated failures, even for the right password', async () => {
    await createAdminUser(ctx);
    for (let i = 0; i < 10; i++) {
      await login({ email: 'admin@example.com', password: 'wrong-password' });
    }
    const res = await login({ email: 'admin@example.com', password: ADMIN_PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rate limits the auth routes per IP', async () => {
    const limited = buildTestApp({ limits: { auth: { windowMs: 60_000, limit: 3 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await request(limited.app).post('/api/auth/login').send({ email: 'a@b.co', password: 'x' });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});

describe('access tokens', () => {
  it('rejects missing, malformed, forged and unsigned tokens', async () => {
    await enrolledAdmin(ctx);
    const get = (token?: string) => {
      const r = request(ctx.app).get('/api/admin/ping');
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    };
    expect((await get()).status).toBe(401);
    expect((await get('garbage')).status).toBe(401);

    const forged = jwt.sign({ role: 'admin', mfa: true, sid: 'x' }, 'x'.repeat(40), {
      subject: 'abc',
      issuer: 'soccer-voting',
    });
    expect((await get(forged)).status).toBe(401);

    const unsigned = jwt.sign({ role: 'admin', mfa: true, sid: 'x' }, '', {
      algorithm: 'none',
      subject: 'abc',
      issuer: 'soccer-voting',
    });
    expect((await get(unsigned)).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const short = buildTestApp({}, { ACCESS_TOKEN_TTL_SECONDS: '1' });
    await createAdminUser(short);
    const l = await request(short.app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: ADMIN_PASSWORD });
    await new Promise((r) => setTimeout(r, 2100));
    const me = await request(short.app).get('/api/auth/me').set('Authorization', bearer(l.body));
    expect(me.status).toBe(401);
  });
});

describe('RBAC', () => {
  it('forbids voters from admin routes', async () => {
    const admin = await createAdminUser(ctx);
    const event = await createEvent(admin._id);
    const voter = await createRegisteredVoter(ctx, event._id);
    const l = await login({ email: voter.email, password: voter.password });
    expect(l.status).toBe(200);
    const res = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(l.body));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('blocks voters who have no open or upcoming event', async () => {
    const admin = await createAdminUser(ctx);
    const event = await createEvent(admin._id, { status: 'closed' });
    const voter = await createRegisteredVoter(ctx, event._id);
    const l = await login({ email: voter.email, password: voter.password });
    expect(l.status).toBe(403);
    expect(l.body.error.code).toBe('NOT_ELIGIBLE');
  });
});

describe('refresh tokens and sessions', () => {
  it('rotates refresh tokens', async () => {
    const { session } = await enrolledAdmin(ctx);
    const r = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(r.status).toBe(200);
    expect(r.body.refreshToken).not.toBe(session.refreshToken);
    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(r.body));
    expect(ping.status).toBe(200);
  });

  it('treats reuse of an old refresh token as theft and revokes the whole session', async () => {
    const { session } = await enrolledAdmin(ctx);
    const rotated = await request(ctx.app)
      .post('/api/auth/refresh')
      .send({ refreshToken: session.refreshToken });
    expect(rotated.status).toBe(200);

    const replay = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(replay.status).toBe(401);

    // The legitimate newest token and its access token are now dead too.
    const next = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(next.status).toBe(401);
    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(rotated.body));
    expect(ping.status).toBe(401);

    expect(await AuditLog.countDocuments({ action: 'auth.refresh_reuse_detected' })).toBe(1);
  });

  it('lets only one of several concurrent refreshes succeed', async () => {
    const { session } = await enrolledAdmin(ctx);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('rejects unknown refresh tokens', async () => {
    const r = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: 'x'.repeat(43) });
    expect(r.status).toBe(401);
  });

  it('logout revokes the session immediately (refresh and access token)', async () => {
    const { session } = await enrolledAdmin(ctx);
    const out = await request(ctx.app).post('/api/auth/logout').send({ refreshToken: session.refreshToken });
    expect(out.status).toBe(204);
    const refresh = await request(ctx.app).post('/api/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(refresh.status).toBe(401);
    const ping = await request(ctx.app).get('/api/admin/ping').set('Authorization', bearer(session));
    expect(ping.status).toBe(401);
  });
});

describe('auditing', () => {
  it('records auth events, keeps the chain valid, and never logs secrets', async () => {
    const { secret, session } = await enrolledAdmin(ctx);
    await login({ email: 'admin@example.com', password: 'wrong-password' });
    await request(ctx.app).post('/api/auth/logout').send({ refreshToken: session.refreshToken });

    const actions = (await AuditLog.find().sort({ seq: 1 }).lean()).map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.login',
        'auth.mfa_setup_started',
        'auth.mfa_enabled',
        'auth.login_failed',
        'auth.logout',
      ]),
    );
    expect((await verifyAuditChain()).valid).toBe(true);

    const dump = JSON.stringify(await AuditLog.find().lean());
    expect(dump).not.toContain(ADMIN_PASSWORD);
    expect(dump).not.toContain('wrong-password');
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(session.refreshToken);
  });
});
