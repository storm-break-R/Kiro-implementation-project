import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getScheduler } from '../src/app.js';
import { AuditLog } from '../src/models/auditLog.js';
import { VotingEvent } from '../src/models/event.js';
import { User } from '../src/models/user.js';
import { Scheduler } from '../src/services/scheduler.js';
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
afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('closes open events whose end time has passed, once, as the system', async () => {
    const expired = await createEvent(adminId, { endsAt: new Date(Date.now() - 1000) });
    const running = await createEvent(adminId);
    const scheduler = getScheduler(ctx.app);

    const first = await scheduler.tick();
    expect(first.closed).toEqual([expired._id.toString()]);
    expect((await VotingEvent.findById(expired._id))!.status).toBe('closed');
    expect((await VotingEvent.findById(running._id))!.status).toBe('open');

    expect((await scheduler.tick()).closed).toEqual([]);
    const audits = await AuditLog.find({ action: 'event.closed' }).lean();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorRole).toBe('system');
  });

  it('heals drifted counters from MongoDB and notifies viewers', async () => {
    const event = await createEvent(adminId);
    const [c] = await createCandidates(event._id);
    const voter = await createRegisteredVoter(ctx, event._id);
    const s = await loginAs(ctx, voter.email, voter.password);
    await request(ctx.app)
      .post(`/api/voter/events/${event._id}/vote`)
      .set('Authorization', bearer(s))
      .send({ candidateId: c!._id.toString() });

    await ctx.redis.client.hset(`tally:${event._id}`, c!._id.toString(), 42);
    const notify = vi.fn();
    const scheduler = new Scheduler(
      { close: vi.fn() } as never,
      new (await import('../src/services/results.js')).TallyService(ctx.redis.client),
      notify,
    );
    const result = await scheduler.tick();
    expect(result.reconciled).toEqual([event._id.toString()]);
    expect(notify).toHaveBeenCalledWith(event._id.toString());
    expect(await ctx.redis.client.hget(`tally:${event._id}`, c!._id.toString())).toBe('1');

    notify.mockClear();
    expect((await scheduler.tick()).reconciled).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('announces events whose voting window has just started', async () => {
    const startsAt = new Date(Date.now() + 60_000);
    const event = await createEvent(adminId, { startsAt });
    const notify = vi.fn();
    const scheduler = new Scheduler(
      { close: vi.fn() } as never,
      new (await import('../src/services/results.js')).TallyService(ctx.redis.client),
      notify,
    );
    expect((await scheduler.tick(new Date())).started).toEqual([]);
    const later = await scheduler.tick(new Date(startsAt.getTime() + 1000));
    expect(later.started).toEqual([event._id.toString()]);
    expect(notify).toHaveBeenCalledWith(event._id.toString());
  });

  it('runs on an interval once started and stops cleanly', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scheduler = new Scheduler({ close: vi.fn() } as never, {} as never, vi.fn(), 1000);
    const tick = vi.spyOn(scheduler, 'tick').mockResolvedValue({ closed: [], started: [], reconciled: [] });
    scheduler.start();
    vi.advanceTimersByTime(3500);
    expect(tick).toHaveBeenCalledTimes(3);
    scheduler.stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});

describe('admin dashboard', () => {
  it('reports turnout per event and in total', async () => {
    const event = await createEvent(adminId);
    const [c] = await createCandidates(event._id);
    const v1 = await createRegisteredVoter(ctx, event._id, { email: 'a@example.com', nationalId: 'AA0001' });
    await createRegisteredVoter(ctx, event._id, { email: 'b@example.com', nationalId: 'BB0002' });
    const s = await loginAs(ctx, v1.email, v1.password);
    await request(ctx.app)
      .post(`/api/voter/events/${event._id}/vote`)
      .set('Authorization', bearer(s))
      .send({ candidateId: c!._id.toString() });

    const res = await request(ctx.app).get('/api/admin/dashboard').set('Authorization', bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ events: 1, open: 1, eligible: 2, registered: 2, voted: 1 });
    expect(res.body.events[0].turnout).toEqual({ eligible: 2, registered: 2, voted: 1, remaining: 1, percent: 50 });
  });

  it('is admin-only', async () => {
    expect((await request(ctx.app).get('/api/admin/dashboard')).status).toBe(401);
  });
});

describe('audit log viewer', () => {
  it('lists entries newest first, filters by action prefix, and verifies the chain', async () => {
    const list = await request(ctx.app).get('/api/admin/audit').set('Authorization', bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.total).toBeGreaterThan(0);
    const seqs = list.body.entries.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));

    const filtered = await request(ctx.app).get('/api/admin/audit?action=auth.mfa').set('Authorization', bearer(admin));
    expect(filtered.body.entries.length).toBeGreaterThan(0);
    expect(filtered.body.entries.every((e: { action: string }) => e.action.startsWith('auth.mfa'))).toBe(true);

    const bad = await request(ctx.app).get('/api/admin/audit?action=.*').set('Authorization', bearer(admin));
    expect(bad.status).toBe(400);

    const verify = await request(ctx.app).get('/api/admin/audit/verify').set('Authorization', bearer(admin));
    expect(verify.body.valid).toBe(true);
  });

  it('reports a tampered chain', async () => {
    await AuditLog.updateOne({ seq: 1 }, { $set: { action: 'rewritten' } });
    const verify = await request(ctx.app).get('/api/admin/audit/verify').set('Authorization', bearer(admin));
    expect(verify.body).toMatchObject({ valid: false, brokenAtSeq: 1 });
  });
});
