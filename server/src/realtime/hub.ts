import type { Server as HttpServer } from 'node:http';
import { createAdapter } from '@socket.io/redis-adapter';
import { Server, type Socket } from 'socket.io';
import type { RedisHandle } from '../infra/redis.js';
import type { ResultsSnapshot } from '../services/results.js';

const OBJECT_ID = /^[a-f\d]{24}$/i;
const MAX_ROOMS_PER_SOCKET = 5;

type Provider = (eventId: string) => Promise<ResultsSnapshot>;
type Ack = (res: { ok: boolean }) => void;

/**
 * Pushes results snapshots to clients in a per-event room. Broadcasts are throttled per event
 * (trailing edge), so a burst of votes produces at most one update per `throttleMs`.
 * Until a socket.io server is attached, notify() is a no-op (tests and scripts).
 */
export class ResultsHub {
  private io?: Server;
  private provider?: Provider;
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly throttleMs = 1000) {}

  setProvider(provider: Provider): void {
    this.provider = provider;
  }

  attach(io: Server): void {
    this.io = io;
    io.on('connection', (socket) => this.onConnection(socket));
  }

  private onConnection(socket: Socket): void {
    socket.on('results:subscribe', async (eventId: unknown, ack?: Ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      if (typeof eventId !== 'string' || !OBJECT_ID.test(eventId) || !this.provider) {
        reply({ ok: false });
        return;
      }
      try {
        const snapshot = await this.provider(eventId);
        const joined = [...socket.rooms].filter((r) => r.startsWith('event:'));
        if (joined.length >= MAX_ROOMS_PER_SOCKET) await socket.leave(joined[0]!);
        await socket.join(`event:${eventId}`);
        socket.emit('results:update', snapshot);
        reply({ ok: true });
      } catch {
        reply({ ok: false });
      }
    });

    socket.on('results:unsubscribe', async (eventId: unknown) => {
      if (typeof eventId === 'string' && OBJECT_ID.test(eventId)) await socket.leave(`event:${eventId}`);
    });
  }

  notify(eventId: string): void {
    if (!this.io || !this.provider || this.timers.has(eventId)) return;
    const timer = setTimeout(async () => {
      this.timers.delete(eventId);
      try {
        const snapshot = await this.provider!(eventId);
        this.io?.to(`event:${eventId}`).emit('results:update', snapshot);
      } catch {
        // The next vote or the reconcile job will try again.
      }
    }, this.throttleMs);
    timer.unref?.();
    this.timers.set(eventId, timer);
  }

  close(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers.clear();
  }
}

/** Create the socket.io server. With a real Redis it uses the Redis adapter to fan out across instances. */
export function createRealtime(
  httpServer: HttpServer,
  hub: ResultsHub,
  opts: { clientOrigin: string; redis: RedisHandle },
): Server {
  const io = new Server(httpServer, {
    cors: { origin: [opts.clientOrigin] },
    serveClient: false,
    maxHttpBufferSize: 10_000,
  });
  if (opts.redis.kind === 'redis') {
    io.adapter(createAdapter(opts.redis.client.duplicate(), opts.redis.client.duplicate()));
  }
  hub.attach(io);
  return io;
}
