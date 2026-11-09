import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { User } from '../src/models/user.js';
import { Ballot, Participation, ballotBucket } from '../src/models/voting.js';
import { verifyAuditChain } from '../src/services/audit.js';
import { TallyService } from '../src/services/results.js';
import {
  bearer,
  buildTestApp,
  createCandidates,
  createEvent,
  createRegisteredVoter,
  enrolledAdmin,
  loginAs,
  type Session,
  type TestContext,
} from './helpers/app.js';
import { clearCollections, connectTestDb, disconnectTestDb } from './helpers/db.js';

let ctx: TestContext;
let admin: Session;
let adminId: Types.ObjectId;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearCollections();
  ctx = buildTestApp();
  admin = (await enrolledAdmin(ctx)).session;
  adminId = (await User.findOne({ role: 'admin' }))!._id;
});

async function openEventWithVoter(overrides: Record<string, unknown> = {}, voterEmail = 'voter@example.com') {
  const event = await createEvent(adminId, overrides);
  const [messi, ronaldo] = await createCandidates(event._id);
  const voter = await createRegisteredVoter(ctx, event._id, { email: voterEmail, nationalId: `ID-${voterEmail}` });
  const session = await loginAs(ctx, voter.email, voter.password);
  return { eventId: event._id.toString(), messi: messi!._id.toString(), ronaldo: ronaldo!._id.toString(), session };
}

const vote = (s: Session, eventId: string, candidateId: string) =>
  request(ctx.app).post(`/api/voter/events/${eventId}/vote`).set('Authorization', bearer(s)).send({ candidateId });

describe('vote submission', () => {
  it('records one participation and one anonymous ballot', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    const res = await vote(session, eventId, messi);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });

    expect(await Participation.countDocuments({ eventId })).toBe(1);
    const ballots = await Ballot.find({ eventId }).lean();
    expect(ballots).toHaveLength(1);
    expect(ballots[0]!.candidateId.toString()).toBe(messi);
    expect(ballots[0]!.bucket.getTime() % (5 * 60_000)).toBe(0);

    const list = await request(ctx.app).get('/api/voter/events').set('Authorization', bearer(session));
    expect(list.body.events[0].hasVoted).toBe(true);
  });

  it('blocks a second vote, even for a different candidate', async () => {
    const { eventId, messi, ronaldo, session } = await openEventWithVoter();
    expect((await vote(session, eventId, messi)).status).toBe(201);
    const again = await vote(session, eventId, ronaldo);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_VOTED');
    expect(await Ballot.countDocuments({ eventId })).toBe(1);
  });

  it('accepts exactly one of many simultaneous votes from the same voter', async () => {
    const { eventId, messi, ronaldo, session } = await openEventWithVoter();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => vote(session, eventId, i % 2 ? messi : ronaldo)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await Ballot.countDocuments({ eventId })).toBe(1);
    expect(await Participation.countDocuments({ eventId })).toBe(1);
  });

  it('rejects votes outside the voting window, whatever the status says', async () => {
    const future = await openEventWithVoter(
      { startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000) },
      'early@example.com',
    );
    const early = await vote(future.session, future.eventId, future.messi);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('VOTING_CLOSED');

    const past = await openEventWithVoter({ endsAt: new Date(Date.now() - 1000) }, 'late@example.com');
    expect((await vote(past.session, past.eventId, past.messi)).status).toBe(409);
    expect(await Ballot.countDocuments()).toBe(0);
  });

  it('rejects votes on a closed event', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    await request(ctx.app).post(`/api/admin/events/${eventId}/close`).set('Authorization', bearer(admin));
    const res = await vote(session, eventId, messi);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VOTING_CLOSED');
  });

  it('rejects a candidate from another event, and malformed ids', async () => {
    const a = await openEventWithVoter();
    const otherEvent = await createEvent(adminId);
    const [foreign] = await createCandidates(otherEvent._id, ['Outsider']);
    const res = await vote(a.session, a.eventId, foreign!._id.toString());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CANDIDATE');
    expect((await vote(a.session, a.eventId, 'not-an-id')).status).toBe(400);
    expect(await Ballot.countDocuments()).toBe(0);
  });

  it('rejects voters who are not registered for that event', async () => {
    const a = await openEventWithVoter();
    const other = await createEvent(adminId);
    const [c] = await createCandidates(other._id, ['X', 'Y']);
    const res = await vote(a.session, other._id.toString(), c!._id.toString());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
  });

  it('is voter-only and needs a session', async () => {
    const { eventId, messi } = await openEventWithVoter();
    expect((await request(ctx.app).post(`/api/voter/events/${eventId}/vote`).send({ candidateId: messi })).status).toBe(401);
    expect((await vote(admin, eventId, messi)).status).toBe(403);
  });

  it('is rate limited', async () => {
    const limited = buildTestApp({ limits: { vote: { windowMs: 60_000, limit: 2 } } });
    const event = await createEvent(adminId);
    const [c] = await createCandidates(event._id);
    const voter = await createRegisteredVoter(limited, event._id, { email: 'rl@example.com', nationalId: 'RL0001' });
    const s = await loginAs(limited, voter.email, voter.password);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await request(limited.app)
        .post(`/api/voter/events/${event._id}/vote`)
        .set('Authorization', bearer(s))
        .send({ candidateId: c!._id.toString() });
      statuses.push(r.status);
    }
    expect(statuses).toEqual([201, 409, 429, 429]);
  });
});

describe('ballot secrecy', () => {
  it('stores nothing on a ballot that points back to the voter', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    await vote(session, eventId, messi);
    const ballot = (await Ballot.findOne({ eventId }).lean())!;
    const participation = (await Participation.findOne({ eventId }).lean())!;
    expect(Object.keys(ballot).sort()).toEqual(['__v', '_id', 'bucket', 'candidateId', 'eventId']);
    expect(JSON.stringify(ballot)).not.toContain(participation.userId.toString());

    // Random ids: neither id encodes the time the vote was written.
    const now = Date.now() / 1000;
    const idTime = (id: Types.ObjectId) => id.getTimestamp().getTime() / 1000;
    expect(Math.abs(idTime(ballot._id) - idTime(participation._id))).toBeGreaterThan(5);
    expect(Math.abs(idTime(ballot._id) - now) > 5 || Math.abs(idTime(participation._id) - now) > 5).toBe(true);
  });

  it('audits the vote without the voter, their IP or their choice', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    await vote(session, eventId, messi);
    const entry = (await AuditLog.findOne({ action: 'vote.cast' }).lean())!;
    expect(entry.actorId).toBeUndefined();
    expect(entry.ip).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(messi);
    expect((await verifyAuditChain()).valid).toBe(true);
  });

  it('audits rejected attempts (who tried, why, but never the choice)', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    await vote(session, eventId, messi);
    await vote(session, eventId, messi);
    const rejected = (await AuditLog.findOne({ action: 'vote.rejected' }).lean())!;
    expect(rejected.meta).toEqual({ reason: 'duplicate' });
    expect(JSON.stringify(rejected)).not.toContain(messi);
  });
});

describe('results', () => {
  it('shows live counts and percentages to anyone', async () => {
    const a = await openEventWithVoter();
    const event = a.eventId;
    await vote(a.session, event, a.messi);
    for (const email of ['v2@example.com', 'v3@example.com']) {
      const v = await createRegisteredVoter(ctx, a.eventId as unknown as Types.ObjectId, { email, nationalId: `ID-${email}` });
      const s = await loginAs(ctx, v.email, v.password);
      await vote(s, event, email === 'v2@example.com' ? a.messi : a.ronaldo);
    }

    const res = await request(ctx.app).get(`/api/events/${event}/results`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalVotes: 3, resultsVisible: true, final: false });
    expect(res.body.turnout).toEqual({ eligible: 3, registered: 3, voted: 3, percent: 100 });
    const byName = Object.fromEntries(res.body.candidates.map((c: { name: string }) => [c.name, c]));
    expect(byName.Messi).toMatchObject({ votes: 2, percent: 66.7 });
    expect(byName.Ronaldo).toMatchObject({ votes: 1, percent: 33.3 });
  });

  it('hides per-candidate counts until close when configured, but not from admins', async () => {
    const { eventId, messi, session } = await openEventWithVoter({ resultsVisibility: 'afterClose' });
    await vote(session, eventId, messi);

    const pub = await request(ctx.app).get(`/api/events/${eventId}/results`);
    expect(pub.body.resultsVisible).toBe(false);
    expect(pub.body.candidates.every((c: { votes: null; percent: null }) => c.votes === null && c.percent === null)).toBe(true);

    const adm = await request(ctx.app).get(`/api/admin/events/${eventId}/results`).set('Authorization', bearer(admin));
    expect(adm.body.resultsVisible).toBe(true);
    expect(adm.body.totalVotes).toBe(1);

    await request(ctx.app).post(`/api/admin/events/${eventId}/close`).set('Authorization', bearer(admin));
    const after = await request(ctx.app).get(`/api/events/${eventId}/results`);
    expect(after.body).toMatchObject({ resultsVisible: true, final: true, totalVotes: 1 });
  });

  it('does not expose drafts or unknown events', async () => {
    const draft = await createEvent(adminId, { status: 'draft' });
    expect((await request(ctx.app).get(`/api/events/${draft._id}/results`)).status).toBe(404);
    expect((await request(ctx.app).get('/api/events/aaaaaaaaaaaaaaaaaaaaaaaa/results')).status).toBe(404);
  });

  it('rebuilds counters from MongoDB when the cache is empty or wrong', async () => {
    const { eventId, messi, session } = await openEventWithVoter();
    await vote(session, eventId, messi);
    await ctx.redis.client.flushall();
    const res = await request(ctx.app).get(`/api/events/${eventId}/results`);
    expect(res.body.totalVotes).toBe(1);

    const tally = new TallyService(ctx.redis.client);
    await ctx.redis.client.hset(`tally:${eventId}`, messi, 999);
    const rebuilt = await tally.rebuild(eventId);
    expect(rebuilt.get(messi)).toBe(1);
    expect((await tally.live(eventId)).get(messi)).toBe(1);
  });

  it('buckets ballots to five minutes', () => {
    expect(ballotBucket(new Date('2026-01-01T10:07:59.999Z')).toISOString()).toBe('2026-01-01T10:05:00.000Z');
  });
});
