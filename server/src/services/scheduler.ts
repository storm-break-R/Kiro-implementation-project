import { VotingEvent } from '../models/event.js';
import type { EventService } from './events.js';
import type { TallyService } from './results.js';

export const SCHEDULER_INTERVAL_MS = 30_000;

export interface TickResult {
  closed: string[];
  started: string[];
  reconciled: string[];
}

/**
 * Background jobs, safe to run on every instance:
 * - closes open events whose end time has passed (close() is idempotent and audits once)
 * - announces events whose voting window has just started, so viewers' pages flip to "open"
 * - rebuilds live counters from MongoDB, healing any increment lost to a crash or race
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private lastTick = new Date();
  private running = false;

  constructor(
    private readonly events: EventService,
    private readonly tally: TallyService,
    private readonly notify: (eventId: string) => void,
    private readonly intervalMs = SCHEDULER_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastTick = new Date();
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => console.error('scheduler:', e instanceof Error ? e.message : e)), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now: Date = new Date()): Promise<TickResult> {
    const result: TickResult = { closed: [], started: [], reconciled: [] };
    if (this.running) return result; // never overlap slow ticks
    this.running = true;
    try {
      const expired = await VotingEvent.find({ status: 'open', endsAt: { $lte: now } }, { _id: 1 }).lean();
      for (const e of expired) {
        const id = e._id.toString();
        await this.events.close(id, { role: 'system' });
        result.closed.push(id);
      }

      const open = await VotingEvent.find({ status: 'open', endsAt: { $gt: now } }, { _id: 1, startsAt: 1 }).lean();
      for (const e of open) {
        const id = e._id.toString();
        const before = await this.tally.live(id);
        const after = await this.tally.rebuild(id);
        const drifted =
          before.size !== after.size || [...after].some(([candidate, n]) => before.get(candidate) !== n);
        if (drifted) result.reconciled.push(id);
        const justStarted = e.startsAt > this.lastTick && e.startsAt <= now;
        if (justStarted) result.started.push(id);
        if (drifted || justStarted) this.notify(id);
      }
      this.lastTick = now;
      return result;
    } finally {
      this.running = false;
    }
  }
}
