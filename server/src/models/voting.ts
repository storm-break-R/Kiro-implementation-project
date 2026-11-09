import { randomBytes } from 'node:crypto';
import { Schema, Types, model } from 'mongoose';

/**
 * Default ObjectIds embed their creation time (to the second). A Participation and a Ballot
 * written in the same transaction would then share a timestamp, linking a voter to their
 * choice. Fully random ids carry no time information.
 */
const randomObjectId = () => new Types.ObjectId(randomBytes(12).toString('hex'));

/**
 * Records THAT a user voted in an event (for duplicate prevention and turnout),
 * but not WHAT they voted for. No timestamps on purpose, to prevent timing correlation.
 */
const participationSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, default: randomObjectId },
    eventId: { type: Schema.Types.ObjectId, ref: 'VotingEvent', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: false },
);
participationSchema.index({ eventId: 1, userId: 1 }, { unique: true });
export const Participation = model('Participation', participationSchema);

/** Ballots are bucketed to 5 minutes: enough for a trend chart, too coarse to time a voter. */
export const BALLOT_BUCKET_MS = 5 * 60_000;
export const ballotBucket = (d: Date) => new Date(Math.floor(d.getTime() / BALLOT_BUCKET_MS) * BALLOT_BUCKET_MS);

/**
 * Records WHAT was voted for, with no link to the voter. `bucket` is a coarse (5 minute)
 * time bucket used only for the votes-over-time chart.
 */
const ballotSchema = new Schema(
  {
    _id: { type: Schema.Types.ObjectId, default: randomObjectId },
    eventId: { type: Schema.Types.ObjectId, ref: 'VotingEvent', required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'Candidate', required: true },
    bucket: { type: Date, required: true },
  },
  { timestamps: false },
);
ballotSchema.index({ eventId: 1, candidateId: 1 });
ballotSchema.index({ eventId: 1, bucket: 1 });
export const Ballot = model('Ballot', ballotSchema);
