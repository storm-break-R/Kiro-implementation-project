import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { Candidate } from '../models/candidate.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent, type EventDoc } from '../models/event.js';
import { Ballot, Participation } from '../models/voting.js';
import { AppError } from '../utils/errors.js';
import { imageUrl, isVotingWindowOpen } from './events.js';

/** Marks a hash as "built", so an event with zero votes still has a cache entry. */
const SENTINEL = '__built';

/**
 * Live per-candidate counters in Redis (HINCRBY), backed by MongoDB as the source of truth.
 * Counters are rebuilt from Mongo on a cache miss and periodically reconciled, so they
 * self-heal after a restart or a missed increment.
 */
export class TallyService {
  constructor(private readonly redis: Redis) {}

  private key(eventId: string) {
    return `tally:${eventId}`;
  }

  async countFromDb(eventId: string): Promise<Map<string, number>> {
    const rows = await Ballot.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { eventId: new Types.ObjectId(eventId) } },
      { $group: { _id: '$candidateId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [r._id.toString(), r.n]));
  }

  async rebuild(eventId: string): Promise<Map<string, number>> {
    const counts = await this.countFromDb(eventId);
    const fields: Record<string, number> = { [SENTINEL]: 1 };
    counts.forEach((n, id) => {
      fields[id] = n;
    });
    const key = this.key(eventId);
    await this.redis.multi().del(key).hset(key, fields).exec();
    return counts;
  }

  async increment(eventId: string, candidateId: string): Promise<void> {
    const key = this.key(eventId);
    if (await this.redis.exists(key)) {
      await this.redis.hincrby(key, candidateId, 1);
    } else {
      // Not cached yet: build from Mongo, which already includes the committed ballot.
      await this.rebuild(eventId);
    }
  }

  async live(eventId: string): Promise<Map<string, number>> {
    const raw = await this.redis.hgetall(this.key(eventId));
    if (!raw || !(SENTINEL in raw)) return this.rebuild(eventId);
    const counts = new Map<string, number>();
    for (const [k, v] of Object.entries(raw)) {
      if (k !== SENTINEL) counts.set(k, Number(v));
    }
    return counts;
  }
}

export interface CandidateResult {
  id: string;
  name: string;
  team: string;
  imageUrl: string | null;
  /** null while results are hidden */
  votes: number | null;
  percent: number | null;
}

export interface ResultsSnapshot {
  eventId: string;
  title: string;
  status: 'open' | 'closed';
  votingOpen: boolean;
  endsAt: string;
  /** False when the event hides results until it closes. */
  resultsVisible: boolean;
  /** True once the event has closed (counts come straight from MongoDB). */
  final: boolean;
  totalVotes: number;
  turnout: { eligible: number; registered: number; voted: number; percent: number };
  candidates: CandidateResult[];
  updatedAt: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export class ResultsService {
  constructor(private readonly tally: TallyService) {}

  /** Public results. `includeHidden` (admins) reveals counts of events that hide them until close. */
  async snapshot(eventId: string, opts: { includeHidden?: boolean } = {}): Promise<ResultsSnapshot> {
    if (!Types.ObjectId.isValid(eventId)) throw AppError.notFound('Event not found');
    const event = await VotingEvent.findById(eventId);
    if (!event || event.status === 'draft') throw AppError.notFound('Event not found');
    return this.build(event, opts.includeHidden ?? false);
  }

  async build(event: EventDoc, includeHidden: boolean): Promise<ResultsSnapshot> {
    const id = event._id.toString();
    const final = event.status === 'closed';
    const [candidates, counts, eligible, registered, voted] = await Promise.all([
      Candidate.find({ eventId: event._id }).sort({ createdAt: 1, _id: 1 }).lean(),
      final ? this.tally.countFromDb(id) : this.tally.live(id),
      EligibleVoter.countDocuments({ eventId: event._id }),
      EligibleVoter.countDocuments({ eventId: event._id, userId: { $exists: true } }),
      Participation.countDocuments({ eventId: event._id }),
    ]);

    const visible = final || event.resultsVisibility === 'live' || includeHidden;
    const totalVotes = candidates.reduce((sum, c) => sum + (counts.get(c._id.toString()) ?? 0), 0);

    return {
      eventId: id,
      title: event.title,
      status: event.status as 'open' | 'closed',
      votingOpen: isVotingWindowOpen(event),
      endsAt: event.endsAt.toISOString(),
      resultsVisible: visible,
      final,
      totalVotes,
      turnout: {
        eligible,
        registered,
        voted,
        percent: eligible ? round1((voted / eligible) * 100) : 0,
      },
      candidates: candidates.map((c) => {
        const votes = counts.get(c._id.toString()) ?? 0;
        return {
          id: c._id.toString(),
          name: c.name,
          team: c.team ?? '',
          imageUrl: imageUrl(c.imageKey),
          votes: visible ? votes : null,
          percent: visible ? (totalVotes ? round1((votes / totalVotes) * 100) : 0) : null,
        };
      }),
      updatedAt: new Date().toISOString(),
    };
  }
}
