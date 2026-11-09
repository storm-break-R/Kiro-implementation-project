import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const eligibleVoterSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'VotingEvent', required: true },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    // National ID is stored only as a keyed hash plus the last 4 characters for admin display.
    nationalIdHash: { type: String, required: true },
    nationalIdLast4: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    email: { type: String, lowercase: true, trim: true },
    // Set when the voter completes registration.
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    registeredAt: { type: Date },
  },
  { timestamps: true },
);

// One row per person per event.
eligibleVoterSchema.index({ eventId: 1, nationalIdHash: 1 }, { unique: true });

export type EligibleVoterDoc = InferSchemaType<typeof eligibleVoterSchema> & {
  _id: Types.ObjectId;
};
export const EligibleVoter = model('EligibleVoter', eligibleVoterSchema);
