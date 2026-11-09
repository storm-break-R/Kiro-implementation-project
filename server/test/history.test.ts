import type { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { User } from '../src/models/user.js';
import { Ballot, BALLOT_BUCKET_MS } from '../src/models/voting.js';
import { rankedResults } from '../src/services/history.js';
import type { ResultsSnapshot } from '../src/services/results.js';
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

/** Event with candidates "=Messi" (formula-looking name), "Ronaldo"; votes per candidate as given. */
async function eventWithVotes(votes: { messi: number; ronaldo: number }, title = 'Player of the Season') {
  const event = await createEvent(adminId, { title });
  const [messi, ronaldo] = await createCandidates(event._id, ['=Messi', 'Ronaldo']);
  let n = 0;
  const cast = async (candidateId: string) => {
    const email = `v${n}-${event._id}@example.com`;
    const v = await createRegisteredVoter(ctx, event._id, { email, nationalId: `ID${n++}${event._id}` });
    const s = await loginAs(ctx, v.email, v.password);
    await request(ctx.app).post(`/api/voter/events/${event._id}/vote`).set('Authorization', bearer(s)).send({ candidateId });
  };
  for (let i = 0; i < votes.messi; i++) await cast(messi!._id.toString());
  for (let i = 0; i < votes.ronaldo; i++) await cast(ronaldo!._id.toString());
  return { id: event._id.toString(), messi: messi!._id.toString(), ronaldo: ronaldo!._id.toString() };
}

const close = (id: string) =>
  request(ctx.app).post(`/api/admin/events/${id}/close`).set('Authorization', bearer(admin));
const exportAs = (id: string, format: 'csv' | 'json') =>
  request(ctx.app).get(`/api/admin/events/${id}/export?format=${format}`).set('Authorization', bearer(admin));

describe('results export', () => {
  it('refuses to export before the event closes', async () => {
    const { id } = await eventWithVotes({ messi: 1, ronaldo: 0 });
    const res = await exportAs(id, 'csv');
    expect(res.status).toBe(409);
  });

  it('exports ranked final results and a turnout summary as CSV, safe for spreadsheets', async () => {
    const { id } = await eventWithVotes({ messi: 1, ronaldo: 2 });
    await close(id);
    const res = await exportAs(id, 'csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="results-.*\.csv"/);
    expect(res.headers['cache-control']).toBe('no-store');

    const lines = res.text.split('\r\n');
    expect(lines.slice(0, 3)).toEqual(['rank,candidate,team,votes,percent', '1,Ronaldo,,2,66.7', "2,'=Messi,,1,33.3"]);
    expect(lines).toContain('total votes,3');
    expect(lines).toContain('eligible voters,3');
    expect(lines).toContain('turnout percent,100');
  });

  it('exports JSON', async () => {
    const { id } = await eventWithVotes({ messi: 2, ronaldo: 1 });
    await close(id);
    const res = await exportAs(id, 'json');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      event: { id, title: 'Player of the Season', status: 'closed' },
      totalVotes: 3,
      turnout: { eligible: 3, voted: 3 },
    });
    expect(res.body.results.map((r: { name: string; rank: number }) => [r.rank, r.name])).toEqual([
      [1, '=Messi'],
      [2, 'Ronaldo'],
    ]);
  });

  it('is audited and admin-only', async () => {
    const { id } = await eventWithVotes({ messi: 1, ronaldo: 0 });
    await close(id);
    await exportAs(id, 'csv');
    const entry = await AuditLog.findOne({ action: 'results.exported' }).lean();
    expect(entry).toMatchObject({ actorRole: 'admin', target: `event:${id}`, meta: { format: 'csv' } });
    expect((await request(ctx.app).get(`/api/admin/events/${id}/export`)).status).toBe(401);
  });

  it('ranks ties together', () => {
    const snap = {
      candidates: [
        { id: 'a', name: 'A', team: '', imageUrl: null, votes: 5, percent: 41.7 },
        { id: 'b', name: 'B', team: '', imageUrl: null, votes: 5, percent: 41.7 },
        { id: 'c', name: 'C', team: '', imageUrl: null, votes: 2, percent: 16.7 },
      ],
    } as ResultsSnapshot;
    expect(rankedResults(snap).map((r) => [r.name, r.rank])).toEqual([
      ['A', 1],
      ['B', 1],
      ['C', 3],
    ]);
  });
});

describe('history', () => {
  it('lists closed events newest first with winners, including ties, and hides open ones', async () => {
    const older = await eventWithVotes({ messi: 1, ronaldo: 1 }, 'Older event');
    await close(older.id);
    const newer = await eventWithVotes({ messi: 0, ronaldo: 2 }, 'Newer event');
    await close(newer.id);
    await eventWithVotes({ messi: 1, ronaldo: 0 }, 'Still open');

    const res = await request(ctx.app).get('/api/events/history');
    expect(res.status).toBe(200);
    const titles = res.body.events.map((e: { title: string }) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Older event', 'Newer event']));
    expect(titles).not.toContain('Still open');

    const byTitle = Object.fromEntries(res.body.events.map((e: { title: string }) => [e.title, e]));
    expect(byTitle['Newer event'].winners.map((w: { name: string }) => w.name)).toEqual(['Ronaldo']);
    expect(byTitle['Older event'].winners).toHaveLength(2);
    expect(byTitle['Newer event']).toMatchObject({ totalVotes: 2, turnoutPercent: 100 });
  });
});

describe('votes over time', () => {
  it('returns totals per bucket with gaps filled and a running total, never per candidate', async () => {
    const { id, messi, ronaldo } = await eventWithVotes({ messi: 0, ronaldo: 0 });
    const t0 = new Date('2026-03-01T10:00:00.000Z').getTime();
    await Ballot.insertMany([
      { eventId: id, candidateId: messi, bucket: new Date(t0) },
      { eventId: id, candidateId: ronaldo, bucket: new Date(t0) },
      { eventId: id, candidateId: messi, bucket: new Date(t0 + 2 * BALLOT_BUCKET_MS) },
    ]);
    const res = await request(ctx.app).get(`/api/events/${id}/timeline`);
    expect(res.status).toBe(200);
    expect(res.body.bucketMinutes).toBe(5);
    expect(res.body.points).toEqual([
      { bucket: '2026-03-01T10:00:00.000Z', votes: 2, cumulative: 2 },
      { bucket: '2026-03-01T10:05:00.000Z', votes: 0, cumulative: 2 },
      { bucket: '2026-03-01T10:10:00.000Z', votes: 1, cumulative: 3 },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(messi);
  });

  it('caps the number of points for long events', async () => {
    const { id, messi } = await eventWithVotes({ messi: 0, ronaldo: 0 });
    const t0 = Date.UTC(2026, 0, 1);
    await Ballot.insertMany([
      { eventId: id, candidateId: messi, bucket: new Date(t0) },
      { eventId: id, candidateId: messi, bucket: new Date(t0 + 30 * 24 * 3600_000) },
    ]);
    const res = await request(ctx.app).get(`/api/events/${id}/timeline`);
    expect(res.body.points.length).toBeLessThanOrEqual(501);
    expect(res.body.points.at(-1).cumulative).toBe(2);
  });

  it('is empty for an event without votes and 404 for drafts', async () => {
    const { id } = await eventWithVotes({ messi: 0, ronaldo: 0 });
    expect((await request(ctx.app).get(`/api/events/${id}/timeline`)).body.points).toEqual([]);
    const draft = await createEvent(adminId, { status: 'draft' });
    expect((await request(ctx.app).get(`/api/events/${draft._id}/timeline`)).status).toBe(404);
  });
});
