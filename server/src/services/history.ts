import { Types } from 'mongoose';
import { VotingEvent } from '../models/event.js';
import { BALLOT_BUCKET_MS, Ballot } from '../models/voting.js';
import { AppError } from '../utils/errors.js';
import type { ResultsService, ResultsSnapshot } from './results.js';

export interface TimelinePoint {
  bucket: string;
  votes: number;
  cumulative: number;
}

export interface HistoryItem {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  closedAt: string | null;
  totalVotes: number;
  turnoutPercent: number;
  winners: Array<{ id: string; name: string; team: string; votes: number; percent: number }>;
}

export class HistoryService {
  constructor(private readonly results: ResultsService) {}

  /**
   * Votes per 5-minute bucket for one event: totals only, never per candidate, so a quiet
   * bucket can't reveal an individual's choice. Empty buckets are filled with zeros.
   */
  async timeline(eventId: string): Promise<{ eventId: string; bucketMinutes: number; points: TimelinePoint[] }> {
    if (!Types.ObjectId.isValid(eventId)) throw AppError.notFound('Event not found');
    const event = await VotingEvent.findById(eventId);
    if (!event || event.status === 'draft') throw AppError.notFound('Event not found');

    const rows = await Ballot.aggregate<{ _id: Date; n: number }>([
      { $match: { eventId: event._id } },
      { $group: { _id: '$bucket', n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const points: TimelinePoint[] = [];
    if (rows.length > 0) {
      const counts = new Map(rows.map((r) => [r._id.getTime(), r.n]));
      const first = rows[0]!._id.getTime();
      const last = rows[rows.length - 1]!._id.getTime();
      // Cap the number of points so a long event can't produce a huge response.
      const step = Math.max(BALLOT_BUCKET_MS, Math.ceil((last - first) / 500 / BALLOT_BUCKET_MS) * BALLOT_BUCKET_MS);
      let cumulative = 0;
      for (let t = first; t <= last; t += step) {
        let votes = 0;
        for (let s = t; s < t + step; s += BALLOT_BUCKET_MS) votes += counts.get(s) ?? 0;
        cumulative += votes;
        points.push({ bucket: new Date(t).toISOString(), votes, cumulative });
      }
    }
    return { eventId, bucketMinutes: BALLOT_BUCKET_MS / 60_000, points };
  }

  /** Closed events, newest first, with their final winners. */
  async closedEvents(limit = 50): Promise<HistoryItem[]> {
    const events = await VotingEvent.find({ status: 'closed' }).sort({ endsAt: -1 }).limit(limit);
    return Promise.all(
      events.map(async (e) => {
        const snap = await this.results.build(e, false);
        const top = Math.max(0, ...snap.candidates.map((c) => c.votes ?? 0));
        return {
          eventId: snap.eventId,
          title: snap.title,
          startsAt: e.startsAt.toISOString(),
          endsAt: e.endsAt.toISOString(),
          closedAt: e.closedAt?.toISOString() ?? null,
          totalVotes: snap.totalVotes,
          turnoutPercent: snap.turnout.percent,
          // Ties are reported as joint winners.
          winners:
            top === 0
              ? []
              : snap.candidates
                  .filter((c) => c.votes === top)
                  .map((c) => ({ id: c.id, name: c.name, team: c.team, votes: c.votes ?? 0, percent: c.percent ?? 0 })),
        };
      }),
    );
  }
}

/** Rows for the results export, ranked (ties share a rank). */
export function rankedResults(snap: ResultsSnapshot) {
  const sorted = [...snap.candidates].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0) || a.name.localeCompare(b.name));
  let rank = 0;
  let prev: number | null = null;
  return sorted.map((c, i) => {
    if (c.votes !== prev) {
      rank = i + 1;
      prev = c.votes;
    }
    return { rank, id: c.id, name: c.name, team: c.team, votes: c.votes ?? 0, percent: c.percent ?? 0 };
  });
}
