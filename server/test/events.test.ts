import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES } from '../src/infra/storage.js';
import { AuditLog } from '../src/models/auditLog.js';
import { Candidate } from '../src/models/candidate.js';
import {
  bearer,
  buildTestApp,
  createAdminUser,
  createEvent,
  createRegisteredVoter,
  enrolledAdmin,
  loginAs,
  type Session,
  type TestContext,
} from './helpers/app.js';
import { clearCollections, connectTestDb, disconnectTestDb } from './helpers/db.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

let ctx: TestContext;
let admin: Session;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearCollections();
  ctx = buildTestApp();
  admin = (await enrolledAdmin(ctx)).session;
});

const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const validEvent = () => ({ title: 'Player of the Season', startsAt: hours(-1), endsAt: hours(24) });

const post = (url: string) => request(ctx.app).post(url).set('Authorization', bearer(admin));

async function makeEvent(overrides: Record<string, unknown> = {}) {
  const res = await post('/api/admin/events').send({ ...validEvent(), ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function addCandidate(eventId: string, name: string, image?: Buffer) {
  const req = post(`/api/admin/events/${eventId}/candidates`).field('name', name);
  if (image) req.attach('image', image, { filename: 'x.png', contentType: 'image/png' });
  return req;
}

describe('access control', () => {
  it('requires an authenticated admin', async () => {
    expect((await request(ctx.app).post('/api/admin/events').send(validEvent())).status).toBe(401);

    const adminUser = await createAdminUser(ctx, 'other@example.com');
    const event = await createEvent(adminUser._id);
    const voter = await createRegisteredVoter(ctx, event._id);
    const voterSession = await loginAs(ctx, voter.email, voter.password);
    const res = await request(ctx.app)
      .post('/api/admin/events')
      .set('Authorization', bearer(voterSession))
      .send(validEvent());
    expect(res.status).toBe(403);
  });
});

describe('event CRUD and validation', () => {
  it('creates a draft event with defaults', async () => {
    const res = await post('/api/admin/events').send(validEvent());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'draft', resultsVisibility: 'live', votingOpen: false });
  });

  it('rejects bad input', async () => {
    expect((await post('/api/admin/events').send({ ...validEvent(), title: 'ab' })).status).toBe(400);
    expect(
      (await post('/api/admin/events').send({ ...validEvent(), startsAt: hours(5), endsAt: hours(2) })).status,
    ).toBe(400);
    expect((await post('/api/admin/events').send({ ...validEvent(), endsAt: hours(-2) })).status).toBe(400);
    expect((await post('/api/admin/events').send({ ...validEvent(), resultsVisibility: 'x' })).status).toBe(400);
  });

  it('updates a draft but not an opened event', async () => {
    const ev = await makeEvent();
    const patched = await request(ctx.app)
      .patch(`/api/admin/events/${ev.id}`)
      .set('Authorization', bearer(admin))
      .send({ title: 'New title here' });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('New title here');

    await addCandidate(ev.id, 'A');
    await addCandidate(ev.id, 'B');
    expect((await post(`/api/admin/events/${ev.id}/open`)).status).toBe(200);

    const again = await request(ctx.app)
      .patch(`/api/admin/events/${ev.id}`)
      .set('Authorization', bearer(admin))
      .send({ title: 'Too late now' });
    expect(again.status).toBe(409);
  });

  it('returns 400 for malformed ids and 404 for unknown ones', async () => {
    const bad = await request(ctx.app).get('/api/admin/events/not-an-id').set('Authorization', bearer(admin));
    expect(bad.status).toBe(400);
    const missing = await request(ctx.app)
      .get('/api/admin/events/aaaaaaaaaaaaaaaaaaaaaaaa')
      .set('Authorization', bearer(admin));
    expect(missing.status).toBe(404);
  });
});

describe('lifecycle rules', () => {
  it('needs two candidates before opening', async () => {
    const ev = await makeEvent();
    await addCandidate(ev.id, 'Only one');
    const res = await post(`/api/admin/events/${ev.id}/open`);
    expect(res.status).toBe(400);
  });

  it('freezes candidates once the event is open', async () => {
    const ev = await makeEvent();
    const a = await addCandidate(ev.id, 'A');
    await addCandidate(ev.id, 'B');
    await post(`/api/admin/events/${ev.id}/open`);

    expect((await addCandidate(ev.id, 'C')).status).toBe(409);
    const patch = await request(ctx.app)
      .patch(`/api/admin/events/${ev.id}/candidates/${a.body.id}`)
      .set('Authorization', bearer(admin))
      .field('name', 'Renamed');
    expect(patch.status).toBe(409);
    const del = await request(ctx.app)
      .delete(`/api/admin/events/${ev.id}/candidates/${a.body.id}`)
      .set('Authorization', bearer(admin));
    expect(del.status).toBe(409);
  });

  it('closes an open event, idempotently, and cannot reopen it', async () => {
    const ev = await makeEvent();
    await addCandidate(ev.id, 'A');
    await addCandidate(ev.id, 'B');
    await post(`/api/admin/events/${ev.id}/open`);

    const closed = await post(`/api/admin/events/${ev.id}/close`);
    expect(closed.body.status).toBe('closed');
    const again = await post(`/api/admin/events/${ev.id}/close`);
    expect(again.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'event.closed' })).toBe(1);

    expect((await post(`/api/admin/events/${ev.id}/open`)).status).toBe(409);
  });

  it('cannot close a draft', async () => {
    const ev = await makeEvent();
    expect((await post(`/api/admin/events/${ev.id}/close`)).status).toBe(409);
  });

  it('deletes only drafts, including candidates and their images', async () => {
    const ev = await makeEvent();
    await addCandidate(ev.id, 'A', PNG);
    expect(ctx.storage.objects.size).toBe(1);
    const del = await request(ctx.app).delete(`/api/admin/events/${ev.id}`).set('Authorization', bearer(admin));
    expect(del.status).toBe(204);
    expect(ctx.storage.objects.size).toBe(0);
    expect(await Candidate.countDocuments()).toBe(0);

    const ev2 = await makeEvent();
    await addCandidate(ev2.id, 'A');
    await addCandidate(ev2.id, 'B');
    await post(`/api/admin/events/${ev2.id}/open`);
    const del2 = await request(ctx.app).delete(`/api/admin/events/${ev2.id}`).set('Authorization', bearer(admin));
    expect(del2.status).toBe(409);
  });
});

describe('candidate images', () => {
  it('stores a valid image, serves it publicly with safe headers, and replaces/removes it', async () => {
    const ev = await makeEvent();
    const c = await addCandidate(ev.id, 'Messi', PNG);
    expect(c.status).toBe(201);
    expect(c.body.imageUrl).toMatch(/^\/api\/images\/candidates\/[a-f0-9-]{36}\.png$/);

    const img = await request(ctx.app).get(c.body.imageUrl);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');

    const replaced = await request(ctx.app)
      .patch(`/api/admin/events/${ev.id}/candidates/${c.body.id}`)
      .set('Authorization', bearer(admin))
      .attach('image', JPEG, { filename: 'y.jpg', contentType: 'image/jpeg' });
    expect(replaced.status).toBe(200);
    expect(replaced.body.imageUrl).toMatch(/\.jpg$/);
    expect(ctx.storage.objects.size).toBe(1);
    expect((await request(ctx.app).get(c.body.imageUrl)).status).toBe(404);

    const removed = await request(ctx.app)
      .patch(`/api/admin/events/${ev.id}/candidates/${c.body.id}`)
      .set('Authorization', bearer(admin))
      .field('removeImage', 'true');
    expect(removed.body.imageUrl).toBeNull();
    expect(ctx.storage.objects.size).toBe(0);
  });

  it('rejects files that are not images even if labelled as images', async () => {
    const ev = await makeEvent();
    const res = await addCandidate(ev.id, 'Fake', Buffer.from('<script>alert(1)</script>'));
    expect(res.status).toBe(400);
    expect(ctx.storage.objects.size).toBe(0);
    expect(await Candidate.countDocuments()).toBe(0);
  });

  it('rejects oversized images', async () => {
    const ev = await makeEvent();
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES + 10)]);
    const res = await addCandidate(ev.id, 'Big', big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('IMAGE_TOO_LARGE');
  });

  it('does not allow path traversal through the image route', async () => {
    for (const url of [
      '/api/images/candidates/..%2f..%2fpackage.json',
      '/api/images/candidates/x.png',
      '/api/images/candidates/..%5c..%5cx.png',
    ]) {
      expect((await request(ctx.app).get(url)).status).toBe(404);
    }
  });
});

describe('public event endpoints', () => {
  it('hides drafts, shows open events with candidates', async () => {
    const draft = await makeEvent({ title: 'Secret draft' });
    const ev = await makeEvent({ title: 'Public event' });
    await addCandidate(ev.id, 'A');
    await addCandidate(ev.id, 'B');
    await post(`/api/admin/events/${ev.id}/open`);

    const list = await request(ctx.app).get('/api/events');
    expect(list.body.events.map((e: { title: string }) => e.title)).toEqual(['Public event']);
    expect((await request(ctx.app).get(`/api/events/${draft.id}`)).status).toBe(404);

    const detail = await request(ctx.app).get(`/api/events/${ev.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.candidates).toHaveLength(2);
    expect(detail.body.votingOpen).toBe(true);
  });
});

describe('auditing', () => {
  it('records admin actions with the actor', async () => {
    const ev = await makeEvent();
    await addCandidate(ev.id, 'A');
    const actions = (await AuditLog.find({ action: /^(event|candidate)\./ }).lean()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['event.created', 'candidate.created']));
    const entry = await AuditLog.findOne({ action: 'event.created' }).lean();
    expect(entry!.actorRole).toBe('admin');
    expect(entry!.actorId).toBeTruthy();
  });
});
