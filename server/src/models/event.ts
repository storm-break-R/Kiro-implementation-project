import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const EVENT_STATUSES = ['draft', 'open', 'closed'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const RESULTS_VISIBILITY = ['live', 'afterClose'] as const;
export type ResultsVisibility = (typeof RESULTS_VISIBILITY)[number];

const eventSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft', index: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    resultsVisibility: { type: String, enum: RESULTS_VISIBILITY, default: 'live' },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    openedAt: { type: Date },
    closedAt: { type: Date },
  },
  { timestamps: true },
);

export type EventDoc = InferSchemaType<typeof eventSchema> & { _id: Types.ObjectId };
export const VotingEvent = model('VotingEvent', eventSchema);
