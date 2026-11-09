import type { Types } from 'mongoose';
import { Candidate, type CandidateDoc } from '../models/candidate.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent, type EventDoc, type ResultsVisibility } from '../models/event.js';
import { VerificationCode } from '../models/verificationCode.js';
import { Ballot, Participation } from '../models/voting.js';
import {
  MAX_IMAGE_BYTES,
  newImageKey,
  sniffImageType,
  type ImageStorage,
} from '../infra/storage.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.js';

export interface Actor {
  id?: string;
  role: 'admin' | 'system';
  ip?: string;
}

const auditActor = (actor: Actor) => ({
  actorId: actor.id,
  actorRole: actor.role,
  ip: actor.ip,
});

export function imageUrl(key?: string | null): string | null {
  return key ? `/api/images/${key}` : null;
}

export function toCandidateDto(c: CandidateDoc) {
  return {
    id: c._id.toString(),
    eventId: c.eventId.toString(),
    name: c.name,
    team: c.team ?? '',
    bio: c.bio ?? '',
    imageUrl: imageUrl(c.imageKey),
  };
}

export function isVotingWindowOpen(event: Pick<EventDoc, 'status' | 'startsAt' | 'endsAt'>, now = new Date()) {
  return event.status === 'open' && event.startsAt <= now && now < event.endsAt;
}

export function toEventDto(e: EventDoc, now = new Date()) {
  return {
    id: e._id.toString(),
    title: e.title,
    description: e.description ?? '',
    status: e.status,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt.toISOString(),
    resultsVisibility: e.resultsVisibility,
    votingOpen: isVotingWindowOpen(e, now),
    openedAt: e.openedAt?.toISOString() ?? null,
    closedAt: e.closedAt?.toISOString() ?? null,
  };
}

export interface EventInput {
  title: string;
  description?: string;
  startsAt: Date;
  endsAt: Date;
  resultsVisibility?: ResultsVisibility;
}

export class EventService {
  constructor(
    private readonly storage: ImageStorage,
    /** Called when an event opens or closes (pushes the new status to live viewers). */
    private readonly onStatusChange: (eventId: string) => void = () => undefined,
  ) {}

  async getEventOrThrow(id: string) {
    const event = await VotingEvent.findById(id);
    if (!event) throw AppError.notFound('Event not found');
    return event;
  }

  private requireDraft(event: { status: string }, what: string) {
    if (event.status !== 'draft') {
      throw AppError.conflict(`${what} can only be changed while the event is a draft`);
    }
  }

  async create(input: EventInput, actor: Actor) {
    if (input.endsAt <= new Date()) throw AppError.badRequest('endsAt must be in the future');
    const event = await new VotingEvent({ ...input, createdBy: actor.id }).save();
    await audit({
      action: 'event.created',
      ...auditActor(actor),
      target: `event:${event._id}`,
      meta: { title: event.title },
    });
    return event;
  }

  async update(id: string, input: Partial<EventInput>, actor: Actor) {
    const event = await this.getEventOrThrow(id);
    this.requireDraft(event, 'Event details');
    Object.assign(event, input);
    if (event.endsAt <= event.startsAt) throw AppError.badRequest('endsAt must be after startsAt');
    await event.save();
    await audit({
      action: 'event.updated',
      ...auditActor(actor),
      target: `event:${id}`,
      meta: { fields: Object.keys(input) },
    });
    return event;
  }

  async remove(id: string, actor: Actor) {
    const event = await this.getEventOrThrow(id);
    this.requireDraft(event, 'Only draft events can be deleted; this event');
    const candidates = await Candidate.find({ eventId: event._id });
    await Promise.all(
      candidates.filter((c) => c.imageKey).map((c) => this.storage.delete(c.imageKey!)),
    );
    await Promise.all([
      Candidate.deleteMany({ eventId: event._id }),
      EligibleVoter.deleteMany({ eventId: event._id }),
      VerificationCode.deleteMany({ eventId: event._id }),
      Participation.deleteMany({ eventId: event._id }),
      Ballot.deleteMany({ eventId: event._id }),
    ]);
    await event.deleteOne();
    await audit({ action: 'event.deleted', ...auditActor(actor), target: `event:${id}` });
  }

  async open(id: string, actor: Actor) {
    const event = await this.getEventOrThrow(id);
    if (event.status !== 'draft') throw AppError.conflict('Only a draft event can be opened');
    if (event.endsAt <= new Date()) throw AppError.badRequest('The voting window has already ended');
    const candidateCount = await Candidate.countDocuments({ eventId: event._id });
    if (candidateCount < 2) throw AppError.badRequest('Add at least two candidates before opening');
    event.status = 'open';
    event.openedAt = new Date();
    await event.save();
    await audit({ action: 'event.opened', ...auditActor(actor), target: `event:${id}` });
    this.onStatusChange(id);
    return event;
  }

  /** Idempotent: closing an already closed event returns it unchanged. */
  async close(id: string, actor: Actor) {
    const event = await this.getEventOrThrow(id);
    if (event.status === 'draft') throw AppError.conflict('A draft event has not been opened');
    if (event.status === 'closed') return event;
    // Conditional update so two concurrent closers audit exactly once.
    const updated = await VotingEvent.findOneAndUpdate(
      { _id: event._id, status: 'open' },
      { $set: { status: 'closed', closedAt: new Date() } },
      { new: true },
    );
    if (updated) {
      await audit({ action: 'event.closed', ...auditActor(actor), target: `event:${id}` });
      this.onStatusChange(id);
      return updated;
    }
    return this.getEventOrThrow(id);
  }

  async listCandidates(eventId: string | Types.ObjectId) {
    return Candidate.find({ eventId }).sort({ createdAt: 1, _id: 1 });
  }

  private async storeImage(file: { buffer: Buffer; size: number }): Promise<string> {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image must be 2 MB or smaller');
    }
    const type = sniffImageType(file.buffer);
    if (!type) throw AppError.badRequest('Image must be a JPEG, PNG or WebP file');
    const key = newImageKey(type);
    await this.storage.put(key, file.buffer, type);
    return key;
  }

  async addCandidate(
    eventId: string,
    input: { name: string; team?: string; bio?: string },
    file: { buffer: Buffer; size: number } | undefined,
    actor: Actor,
  ) {
    const event = await this.getEventOrThrow(eventId);
    this.requireDraft(event, 'Candidates');
    const imageKey = file ? await this.storeImage(file) : undefined;
    const candidate = await new Candidate({ ...input, eventId: event._id, imageKey }).save();
    await audit({
      action: 'candidate.created',
      ...auditActor(actor),
      target: `candidate:${candidate._id}`,
      meta: { eventId, name: candidate.name, hasImage: !!imageKey },
    });
    return candidate;
  }

  async updateCandidate(
    eventId: string,
    candidateId: string,
    input: { name?: string; team?: string; bio?: string; removeImage?: boolean },
    file: { buffer: Buffer; size: number } | undefined,
    actor: Actor,
  ) {
    const event = await this.getEventOrThrow(eventId);
    this.requireDraft(event, 'Candidates');
    const candidate = await Candidate.findOne({ _id: candidateId, eventId: event._id });
    if (!candidate) throw AppError.notFound('Candidate not found');

    const { removeImage, ...fields } = input;
    Object.assign(candidate, fields);
    const oldKey = candidate.imageKey;
    if (file) {
      candidate.imageKey = await this.storeImage(file);
    } else if (removeImage) {
      candidate.imageKey = undefined;
    }
    await candidate.save();
    if (oldKey && oldKey !== candidate.imageKey) await this.storage.delete(oldKey);

    await audit({
      action: 'candidate.updated',
      ...auditActor(actor),
      target: `candidate:${candidateId}`,
      meta: { eventId, fields: Object.keys(fields), imageChanged: !!file || !!removeImage },
    });
    return candidate;
  }

  async removeCandidate(eventId: string, candidateId: string, actor: Actor) {
    const event = await this.getEventOrThrow(eventId);
    this.requireDraft(event, 'Candidates');
    const candidate = await Candidate.findOneAndDelete({ _id: candidateId, eventId: event._id });
    if (!candidate) throw AppError.notFound('Candidate not found');
    if (candidate.imageKey) await this.storage.delete(candidate.imageKey);
    await audit({
      action: 'candidate.deleted',
      ...auditActor(actor),
      target: `candidate:${candidateId}`,
      meta: { eventId },
    });
  }
}
