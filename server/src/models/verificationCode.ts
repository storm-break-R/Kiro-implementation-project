import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const verificationCodeSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'VotingEvent', required: true, index: true },
    // Exactly one code per eligible voter.
    eligibleVoterId: {
      type: Schema.Types.ObjectId,
      ref: 'EligibleVoter',
      required: true,
      unique: true,
    },
    // HMAC-SHA256 of the normalized code (never the plaintext).
    codeHash: { type: String, required: true, unique: true },
    used: { type: Boolean, default: false },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

export type VerificationCodeDoc = InferSchemaType<typeof verificationCodeSchema> & {
  _id: Types.ObjectId;
};
export const VerificationCode = model('VerificationCode', verificationCodeSchema);
