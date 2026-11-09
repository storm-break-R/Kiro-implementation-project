import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const ROLES = ['admin', 'voter'] as const;
export type Role = (typeof ROLES)[number];

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    // Admin MFA. The secret is AES-GCM encrypted at rest; enabled only after first verification.
    totpSecretEnc: { type: String },
    totpEnabled: { type: Boolean, default: false },
    // Voters: the eligible-voter rows (one per event) that this account has claimed.
    eligibleVoterIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  { timestamps: true },
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model('User', userSchema);
