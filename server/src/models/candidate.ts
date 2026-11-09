import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const candidateSchema = new Schema(
  {
    eventId: { type: Schema.Types.ObjectId, ref: 'VotingEvent', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    team: { type: String, trim: true, maxlength: 120, default: '' },
    bio: { type: String, trim: true, maxlength: 1000, default: '' },
    // Storage key (local path or S3 object key). Never a raw URL.
    imageKey: { type: String },
  },
  { timestamps: true },
);

export type CandidateDoc = InferSchemaType<typeof candidateSchema> & { _id: Types.ObjectId };
export const Candidate = model('Candidate', candidateSchema);
