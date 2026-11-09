import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Types } from 'mongoose';
import type { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { User } from '../src/models/user.js';
import { ResultsHub, createRealtime } from '../src/realtime/hub.js';
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
let hub: ResultsHub;
let http: HttpServer;
let io: Server;
let url: string;
let admin: Session;
const sockets: Socket[] = [];

beforeAll(connectTestDb);
afterAll(disconnectTestDb);

beforeEach(async () => {
  await clearCollections();
  hub = new ResultsHub(50);
  ctx = buildTestApp({ hub });
  http = createServer(ctx.app);
  io = createRealtime(http, hub, { clientOrigin: ctx.env.CLIENT_ORIGIN, redis: ctx.redis });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  admin = (await enrolledAdmin(ctx)).session;
});

afterEach(async () => {
  sockets.splice(0).forEach((s) => s.disconnect());
  hub.close();
  await io.close();
});

function client(): Socket {
  const s = connect(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

function subscribe(s: Socket, eventId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => s.emit('results:subscribe', eventId, resolve));
}

/** Resolve with the first update that satisfies `pred`. */
function nextUpdate(s: Socket, pred: (u: ResultsSnapshot) => boolean, timeoutMs = 5000): Promise<ResultsSnapshot> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no matching update')), timeoutMs);
    const handler = (u: ResultsSnapshot) => {
      if (pred(u)) {
        clearTimeout(timer);
        s.off('results:update', handler);
        resolve(u);
      }
    };
    s.on('results:update', handler);
  });
}

async function setup() {
  const adminId = (await User.findOne({ role: 'admin' }))!._id as Types.ObjectId;
  const event = await createEvent(adminId);
  const [messi] = await createCandidates(event._id);
  const voter = await createRegisteredVoter(ctx, event._id);
  const session = await loginAs(ctx, voter.email, voter.password);
  return { eventId: event._id.toString(), messi: messi!._id.toString(), session };
}

describe('live results over socket.io', () => {
  it('sends a snapshot on subscribe and a fresh one after each vote', async () => {
    const { eventId, messi, session } = await setup();
    const viewer = client();
    const first = nextUpdate(viewer, () => true);
    expect(await subscribe(viewer, eventId)).toEqual({ ok: true });
    expect((await first).totalVotes).toBe(0);

    const updated = nextUpdate(viewer, (u) => u.totalVotes === 1);
    await request(ctx.app)
      .post(`/api/voter/events/${eventId}/vote`)
      .set('Authorization', bearer(session))
      .send({ candidateId: messi });
    const snap = await updated;
    expect(snap.candidates.find((c) => c.id === messi)!.votes).toBe(1);
    expect(snap.turnout.voted).toBe(1);
  });

  it('pushes status changes when an admin closes the event', async () => {
    const { eventId } = await setup();
    const viewer = client();
    await subscribe(viewer, eventId);
    const closed = nextUpdate(viewer, (u) => u.status === 'closed');
    await request(ctx.app).post(`/api/admin/events/${eventId}/close`).set('Authorization', bearer(admin));
    expect((await closed).final).toBe(true);
  });

  it('only sends updates to subscribers of that event', async () => {
    const a = await setup();
    const adminId = (await User.findOne({ role: 'admin' }))!._id as Types.ObjectId;
    const other = await createEvent(adminId);
    await createCandidates(other._id);

    const viewer = client();
    await subscribe(viewer, other._id.toString());
    const received: ResultsSnapshot[] = [];
    viewer.on('results:update', (u: ResultsSnapshot) => received.push(u));

    await request(ctx.app)
      .post(`/api/voter/events/${a.eventId}/vote`)
      .set('Authorization', bearer(a.session))
      .send({ candidateId: a.messi });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.every((u) => u.eventId === other._id.toString())).toBe(true);
  });

  it('rejects bad subscriptions', async () => {
    const viewer = client();
    expect(await subscribe(viewer, 'nope')).toEqual({ ok: false });
    expect(await subscribe(viewer, 'aaaaaaaaaaaaaaaaaaaaaaaa')).toEqual({ ok: false });
  });

  it('coalesces a burst of notifications into one broadcast', async () => {
    const { eventId } = await setup();
    const viewer = client();
    await subscribe(viewer, eventId);
    const received: ResultsSnapshot[] = [];
    viewer.on('results:update', (u: ResultsSnapshot) => received.push(u));
    for (let i = 0; i < 20; i++) hub.notify(eventId);
    await new Promise((r) => setTimeout(r, 400));
    expect(received).toHaveLength(1);
  });
});
