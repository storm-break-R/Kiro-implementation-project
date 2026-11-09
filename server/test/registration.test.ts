import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { EligibleVoter } from '../src/models/eligibleVoter.js';
import { User } from '../src/models/user.js';
import { VerificationCode } from '../src/models/verificationCode.js';
import { hashCode } from '../src/utils/crypto.js';
import {
  bearer,
  buildTestApp,
  createEvent,
  enrolledAdmin,
  type Session,
  type TestContext,
} from './helpers/app.js';
import { clearCollections, connectTestDb, disconnectTestDb } from './helpers/db.js';

let ctx: TestContext;
let admin: Session;
let adminId: import('mongoose').Types.ObjectId;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearCollections();
  ctx = buildTestApp();
  admin = (await enrolledAdmin(ctx)).session;
  adminId = (await User.findOne({ role: 'admin' }))!._id;
});

const CSV = [
  'name,nationalId,dateOfBirth,email',
  'Alice Adams,AB-1001,1990-05-17,alice@example.com',
  'Bob Brown,BB1002,1985-12-01,bob@example.com',
  'Carl Child,CC1003,2015-01-01,carl@example.com',
].join('\n');

/** Create an event, import voters and issue codes through the real admin API. */
async function setupEvent(status: 'draft' | 'open' | 'closed' = 'draft', csv = CSV) {
  const event = await createEvent(adminId, { status });
  const id = event._id.toString();
  if (status === 'closed') {
    // Closed events cannot be edited, so set the voters up while it is still a draft.
    await event.updateOne({ status: 'draft' });
  }
  await request(ctx.app)
    .post(`/api/admin/events/${id}/voters/import`)
    .set('Authorization', bearer(admin))
    .attach('file', Buffer.from(csv), 'v.csv');
  const gen = await request(ctx.app)
    .post(`/api/admin/events/${id}/codes/generate`)
    .set('Authorization', bearer(admin));
  if (status === 'closed') await event.updateOne({ status: 'closed' });
  const codes: Record<string, string> = {};
  for (const c of gen.body.codes as Array<{ fullName: string; code: string }>) codes[c.fullName] = c.code;
  return { id, codes };
}

const register = (body: Record<string, unknown>) => request(ctx.app).post('/api/auth/register').send(body);
const good = (over: Record<string, unknown> = {}) => ({
  nationalId: 'AB-1001',
  code: 'x',
  email: 'alice@example.com',
  password: 'a-strong-password',
  ...over,
});

describe('voter registration', () => {
  it('registers an eligible voter, consumes the code, links the account and signs them in', async () => {
    const { id, codes } = await setupEvent('open');
    const res = await register(good({ code: codes['Alice Adams'] }));
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', role: 'voter' });
    expect(res.body.accessToken).toBeTruthy();

    const user = await User.findOne({ email: 'alice@example.com' });
    expect(user!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user!.eligibleVoterIds).toHaveLength(1);
    const voter = await EligibleVoter.findOne({ eventId: id, fullName: 'Alice Adams' });
    expect(voter!.userId!.toString()).toBe(user!._id.toString());
    const code = await VerificationCode.findOne({ eligibleVoterId: voter!._id });
    expect(code!.used).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'voter.registered' })).toBe(1);

    const events = await request(ctx.app).get('/api/voter/events').set('Authorization', bearer(res.body));
    expect(events.status).toBe(200);
    expect(events.body.events).toHaveLength(1);
    expect(events.body.events[0]).toMatchObject({ id, hasVoted: false, votingOpen: true });
  });

  it('accepts the code typed in lower case without dashes, and the ID with spaces', async () => {
    const { codes } = await setupEvent('open');
    const typed = codes['Alice Adams']!.replace(/-/g, '').toLowerCase();
    const res = await register(good({ code: typed, nationalId: ' ab 1001 ' }));
    expect(res.status).toBe(201);
  });

  it('lets the voter sign in afterwards', async () => {
    const { codes } = await setupEvent('open');
    await register(good({ code: codes['Alice Adams'] }));
    const login = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'a-strong-password' });
    expect(login.status).toBe(200);
  });

  it('rejects a second registration with the same code', async () => {
    const { codes } = await setupEvent('open');
    expect((await register(good({ code: codes['Alice Adams'] }))).status).toBe(201);
    const second = await register(good({ code: codes['Alice Adams'], email: 'other@example.com' }));
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('REGISTRATION_FAILED');
    expect(await User.countDocuments({ role: 'voter' })).toBe(1);
  });

  it('does not reveal why a registration failed and does not burn the code on a wrong ID', async () => {
    const { codes } = await setupEvent('open');
    const wrongId = await register(good({ code: codes['Alice Adams'], nationalId: 'ZZ9999' }));
    const unknownCode = await register(good({ code: 'AAAAA-BBBBB-CCCCC' }));
    const otherVoterCode = await register(good({ code: codes['Bob Brown'] }));
    for (const r of [wrongId, unknownCode, otherVoterCode]) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('REGISTRATION_FAILED');
      expect(r.body.error.message).toBe(wrongId.body.error.message);
    }
    // Alice can still register with the right ID, and Bob's code was not consumed by Alice's try.
    expect((await register(good({ code: codes['Alice Adams'] }))).status).toBe(201);
    expect(await VerificationCode.countDocuments({ used: false })).toBe(2);
  });

  it('rejects voters under 18 without consuming their code', async () => {
    const { codes } = await setupEvent('open');
    const res = await register(
      good({ code: codes['Carl Child'], nationalId: 'CC1003', email: 'carl@example.com' }),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNDERAGE');
    expect(await User.countDocuments({ email: 'carl@example.com' })).toBe(0);
    expect(await VerificationCode.countDocuments({ used: true })).toBe(0);
  });

  it('rejects registration for a closed event', async () => {
    const { codes } = await setupEvent('closed');
    const res = await register(good({ code: codes['Alice Adams'] }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REGISTRATION_FAILED');
  });

  it('validates input shape and password strength', async () => {
    const { codes } = await setupEvent('open');
    const weak = await register(good({ code: codes['Alice Adams'], password: 'short' }));
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect((await register(good({ code: codes['Alice Adams'], email: 'nope' }))).status).toBe(400);
    expect((await register({})).status).toBe(400);
    expect(await VerificationCode.countDocuments({ used: true })).toBe(0);
  });

  it('refuses an email that belongs to someone else, or to an admin', async () => {
    const { codes } = await setupEvent('open');
    expect((await register(good({ code: codes['Alice Adams'], email: 'admin@example.com' }))).status).toBe(400);

    expect((await register(good({ code: codes['Alice Adams'] }))).status).toBe(201);
    const taken = await register(
      good({ code: codes['Bob Brown'], nationalId: 'BB1002', email: 'alice@example.com', password: 'not-alices-password' }),
    );
    expect(taken.status).toBe(400);
    expect(await VerificationCode.countDocuments({ used: true })).toBe(1);
  });

  it('links a second event to an existing account when the password matches', async () => {
    const first = await setupEvent('open');
    await register(good({ code: first.codes['Alice Adams'] }));

    const second = await setupEvent('open');
    const res = await register(good({ code: second.codes['Alice Adams'] }));
    expect(res.status).toBe(201);
    const user = await User.findOne({ email: 'alice@example.com' });
    expect(user!.eligibleVoterIds).toHaveLength(2);
    expect(await User.countDocuments({ role: 'voter' })).toBe(1);

    const events = await request(ctx.app).get('/api/voter/events').set('Authorization', bearer(res.body));
    expect(events.body.events).toHaveLength(2);
  });

  it('lets exactly one of many simultaneous registrations with the same code succeed', async () => {
    const { codes } = await setupEvent('open');
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        register(good({ code: codes['Alice Adams'], email: `racer${i}@example.com` })),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(5);
    expect(await User.countDocuments({ role: 'voter' })).toBe(1);
    const stored = await VerificationCode.findOne({ codeHash: hashCode(codes['Alice Adams']!, ctx.env.CODE_PEPPER) });
    expect(stored!.used).toBe(true);
    expect(await EligibleVoter.countDocuments({ userId: { $exists: true } })).toBe(1);
  });

  it('rate limits registration attempts per IP', async () => {
    const limited = buildTestApp({ limits: { register: { windowMs: 60_000, limit: 2 } } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(limited.app).post('/api/auth/register').send(good({ code: 'AAAAA-BBBBB-CCCCC' }));
      statuses.push(r.status);
    }
    expect(statuses).toEqual([400, 400, 429, 429]);
  });
});

describe('voter events endpoint', () => {
  it('is voter-only', async () => {
    expect((await request(ctx.app).get('/api/voter/events')).status).toBe(401);
    const res = await request(ctx.app).get('/api/voter/events').set('Authorization', bearer(admin));
    expect(res.status).toBe(403);
  });
});
