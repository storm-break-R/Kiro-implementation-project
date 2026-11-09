import mongoose from 'mongoose';
import { Candidate } from '../models/candidate.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent } from '../models/event.js';
import { Ballot, Participation, ballotBucket } from '../models/voting.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.js';
import { isVotingWindowOpen } from './events.js';
import type { TallyService } from './results.js';

export class VotingService {
  constructor(
    private readonly tally: TallyService,
    /** Called after a vote commits (drives the live results broadcast). */
    private readonly onVote: (eventId: string) => void = () => undefined,
  ) {}

  async cast(userId: string, eventId: string, candidateId: string, meta: { ip?: string }): Promise<void> {
    const event = await VotingEvent.findById(eventId);
    if (!event || event.status === 'draft') throw AppError.notFound('Event not found');

    const reject = async (status: number, code: string, message: string, reason: string) => {
      await audit({
        action: 'vote.rejected',
        actorId: userId,
        actorRole: 'voter',
        ip: meta.ip,
        target: `event:${eventId}`,
        meta: { reason },
      });
      return new AppError(status, code, message);
    };

    if (!(await EligibleVoter.exists({ eventId: event._id, userId }))) {
      throw await reject(403, 'NOT_ELIGIBLE', 'You are not registered to vote in this event', 'not_eligible');
    }
    // Enforced here, not just in the UI: the status must be open AND the clock inside the window.
    if (!isVotingWindowOpen(event)) {
      throw await reject(409, 'VOTING_CLOSED', 'Voting is not open for this event', 'window_closed');
    }
    if (!(await Candidate.exists({ _id: candidateId, eventId: event._id }))) {
      throw await reject(400, 'INVALID_CANDIDATE', 'That candidate is not part of this event', 'bad_candidate');
    }

    // Both writes commit together or not at all. The unique (eventId, userId) index on
    // Participation is what makes a second vote impossible, even under concurrency.
    try {
      await mongoose.connection.transaction(async (session) => {
        await Participation.create([{ eventId: event._id, userId }], { session });
        await Ballot.create(
          [{ eventId: event._id, candidateId, bucket: ballotBucket(new Date()) }],
          { session },
        );
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw await reject(409, 'ALREADY_VOTED', 'You have already voted in this event', 'duplicate');
      }
      throw err;
    }

    // Post-commit work is best effort: MongoDB holds the truth and the counters self-heal.
    await this.tally.increment(eventId, candidateId).catch(() => undefined);
    this.onVote(eventId);
    // Deliberately no actor, IP or choice: with them, the log could re-link a voter to a ballot.
    await audit({ action: 'vote.cast', target: `event:${eventId}` });
  }
}
