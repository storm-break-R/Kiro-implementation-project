import { parse } from 'csv-parse/sync';
import mongoose, { type Types } from 'mongoose';
import { z } from 'zod';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent } from '../models/event.js';
import { VerificationCode } from '../models/verificationCode.js';
import { isAdult, parseIsoDate } from '../utils/age.js';
import { generateCode, hashCode, hashNationalId, normalizeNationalId } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.js';
import type { Actor } from './events.js';

export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const MAX_CSV_ROWS = 10_000;

const HEADER_ALIASES: Record<string, string> = {
  name: 'fullName',
  fullname: 'fullName',
  nationalid: 'nationalId',
  id: 'nationalId',
  dob: 'dateOfBirth',
  dateofbirth: 'dateOfBirth',
  birthdate: 'dateOfBirth',
  email: 'email',
};

const rowSchema = z.object({
  fullName: z.string().trim().min(1, 'name is required').max(120, 'name is too long'),
  nationalId: z
    .string()
    .transform(normalizeNationalId)
    .pipe(z.string().regex(/^[A-Z0-9]{4,30}$/, 'national ID must be 4-30 letters or digits')),
  dateOfBirth: z.string().trim(),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((v) => v === '' || z.email().safeParse(v).success, 'email is not valid')
    .optional(),
});

export interface ImportError {
  row: number; // 1-based, counting the header as row 1
  message: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  under18: number;
  errors: ImportError[];
}

export interface IssuedCode {
  voterId: string;
  fullName: string;
  email: string;
  nationalIdLast4: string;
  code: string;
}

export class VoterService {
  constructor(private readonly pepper: string) {}

  private async editableEvent(eventId: string) {
    const event = await VotingEvent.findById(eventId);
    if (!event) throw AppError.notFound('Event not found');
    if (event.status === 'closed') throw AppError.conflict('This event is closed');
    return event;
  }

  async importCsv(eventId: string, file: Buffer, actor: Actor): Promise<ImportResult> {
    const event = await this.editableEvent(eventId);

    let records: Array<Record<string, string>>;
    try {
      records = parse(file, {
        columns: (header: string[]) =>
          header.map((h) => HEADER_ALIASES[h.toLowerCase().replace(/[^a-z]/g, '')] ?? `ignored:${h}`),
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch {
      throw AppError.badRequest('The file is not valid CSV');
    }
    if (records.length > MAX_CSV_ROWS) {
      throw AppError.badRequest(`A file can contain at most ${MAX_CSV_ROWS} voters`);
    }
    const first = records[0];
    if (first && !('fullName' in first && 'nationalId' in first && 'dateOfBirth' in first)) {
      throw AppError.badRequest('CSV needs the columns: name, nationalId, dateOfBirth (YYYY-MM-DD), email');
    }

    const errors: ImportError[] = [];
    const seen = new Set<string>();
    const valid: Array<{
      row: number;
      fullName: string;
      idHash: string;
      last4: string;
      dob: Date;
      email?: string;
    }> = [];
    let under18 = 0;

    records.forEach((record, i) => {
      const rowNumber = i + 2;
      const parsed = rowSchema.safeParse(record);
      if (!parsed.success) {
        errors.push({ row: rowNumber, message: parsed.error.issues.map((x) => x.message).join('; ') });
        return;
      }
      const dob = parseIsoDate(parsed.data.dateOfBirth);
      if (!dob) {
        errors.push({ row: rowNumber, message: 'dateOfBirth must be a real date in YYYY-MM-DD format' });
        return;
      }
      if (dob > new Date() || dob.getUTCFullYear() < 1900) {
        errors.push({ row: rowNumber, message: 'dateOfBirth is not plausible' });
        return;
      }
      const idHash = hashNationalId(parsed.data.nationalId, this.pepper);
      if (seen.has(idHash)) {
        errors.push({ row: rowNumber, message: 'duplicate national ID in this file' });
        return;
      }
      seen.add(idHash);
      if (!isAdult(dob)) under18++;
      valid.push({
        row: rowNumber,
        fullName: parsed.data.fullName,
        idHash,
        last4: parsed.data.nationalId.slice(-4),
        dob,
        email: parsed.data.email || undefined,
      });
    });

    // Reject rows already on this event's list.
    const existing = new Set(
      (
        await EligibleVoter.find(
          { eventId: event._id, nationalIdHash: { $in: valid.map((v) => v.idHash) } },
          { nationalIdHash: 1 },
        ).lean()
      ).map((e) => e.nationalIdHash),
    );
    const toInsert = valid.filter((v) => {
      if (existing.has(v.idHash)) {
        errors.push({ row: v.row, message: 'already on this event\'s voter list' });
        return false;
      }
      return true;
    });

    let imported = 0;
    if (toInsert.length > 0) {
      try {
        const res = await EligibleVoter.insertMany(
          toInsert.map((v) => ({
            eventId: event._id,
            fullName: v.fullName,
            nationalIdHash: v.idHash,
            nationalIdLast4: v.last4,
            dateOfBirth: v.dob,
            email: v.email,
          })),
          { ordered: false },
        );
        imported = res.length;
      } catch (err) {
        // A concurrent import may have won the race on some rows; report them as duplicates.
        const writeErrors = (err as { writeErrors?: Array<{ index: number }> }).writeErrors;
        if (!writeErrors) throw err;
        const failed = new Set(writeErrors.map((w) => w.index));
        failed.forEach((idx) => errors.push({ row: toInsert[idx]!.row, message: 'already on this event\'s voter list' }));
        imported = toInsert.length - failed.size;
      }
    }

    errors.sort((a, b) => a.row - b.row);
    await audit({
      action: 'voters.imported',
      actorId: actor.id,
      actorRole: actor.role,
      ip: actor.ip,
      target: `event:${eventId}`,
      meta: { imported, rejected: errors.length, under18 },
    });
    return { imported, skipped: errors.length, under18, errors };
  }

  async list(eventId: string, opts: { page: number; limit: number; q?: string }) {
    const event = await VotingEvent.findById(eventId);
    if (!event) throw AppError.notFound('Event not found');
    const filter: Record<string, unknown> = { eventId: event._id };
    if (opts.q) {
      const escaped = opts.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { fullName: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
        { nationalIdLast4: opts.q.toUpperCase() },
      ];
    }
    const [rows, total, totals] = await Promise.all([
      EligibleVoter.find(filter)
        .sort({ fullName: 1, _id: 1 })
        .skip((opts.page - 1) * opts.limit)
        .limit(opts.limit)
        .lean(),
      EligibleVoter.countDocuments(filter),
      this.totals(event._id),
    ]);
    const codes = await VerificationCode.find(
      { eligibleVoterId: { $in: rows.map((r) => r._id) } },
      { eligibleVoterId: 1, used: 1 },
    ).lean();
    const codeStatus = new Map(codes.map((c) => [c.eligibleVoterId.toString(), c.used ? 'used' : 'unused']));

    return {
      voters: rows.map((r) => ({
        id: r._id.toString(),
        fullName: r.fullName,
        email: r.email ?? '',
        nationalIdLast4: r.nationalIdLast4,
        registered: !!r.userId,
        codeStatus: (codeStatus.get(r._id.toString()) ?? 'none') as 'none' | 'unused' | 'used',
      })),
      total,
      page: opts.page,
      limit: opts.limit,
      totals,
    };
  }

  async totals(eventId: Types.ObjectId) {
    const [eligible, registered, codesIssued] = await Promise.all([
      EligibleVoter.countDocuments({ eventId }),
      EligibleVoter.countDocuments({ eventId, userId: { $exists: true } }),
      VerificationCode.countDocuments({ eventId }),
    ]);
    return { eligible, registered, codesIssued };
  }

  async remove(eventId: string, voterId: string, actor: Actor) {
    await this.editableEvent(eventId);
    const voter = await EligibleVoter.findOne({ _id: voterId, eventId });
    if (!voter) throw AppError.notFound('Voter not found');
    if (voter.userId) throw AppError.conflict('This voter has already registered');
    await VerificationCode.deleteOne({ eligibleVoterId: voter._id });
    await voter.deleteOne();
    await audit({
      action: 'voter.removed',
      actorId: actor.id,
      actorRole: actor.role,
      ip: actor.ip,
      target: `event:${eventId}`,
      meta: { voterId },
    });
  }

  /**
   * Issue a code to every voter that doesn't have one yet. Plaintext codes are returned once
   * (only their HMAC is stored), so the caller must hand them over immediately.
   */
  async generateMissingCodes(eventId: string, actor: Actor): Promise<IssuedCode[]> {
    const event = await this.editableEvent(eventId);
    const withCode = new Set(
      (await VerificationCode.find({ eventId: event._id }, { eligibleVoterId: 1 }).lean()).map((c) =>
        c.eligibleVoterId.toString(),
      ),
    );
    const voters = (await EligibleVoter.find({ eventId: event._id }).sort({ fullName: 1, _id: 1 }).lean()).filter(
      (v) => !withCode.has(v._id.toString()),
    );

    const issued: IssuedCode[] = [];
    let pending = voters;
    for (let round = 0; pending.length > 0; round++) {
      if (round >= 5) throw new Error('Could not generate unique codes');
      const batch = pending.map((v) => ({ v, code: generateCode() }));
      const failedIdx = new Set<number>();
      try {
        await VerificationCode.collection.insertMany(
          batch.map(({ v, code }) => ({
            eventId: event._id,
            eligibleVoterId: v._id,
            codeHash: hashCode(code, this.pepper),
            used: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
          { ordered: false },
        );
      } catch (err) {
        if (!(err instanceof mongoose.mongo.MongoBulkWriteError)) throw err;
        const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
        for (const w of writeErrors) failedIdx.add(w.index);
      }
      const retry: typeof pending = [];
      batch.forEach(({ v, code }, idx) => {
        if (failedIdx.has(idx)) {
          retry.push(v);
        } else {
          issued.push({
            voterId: v._id.toString(),
            fullName: v.fullName,
            email: v.email ?? '',
            nationalIdLast4: v.nationalIdLast4,
            code,
          });
        }
      });
      pending = retry;
    }

    await audit({
      action: 'codes.generated',
      actorId: actor.id,
      actorRole: actor.role,
      ip: actor.ip,
      target: `event:${eventId}`,
      meta: { count: issued.length },
    });
    return issued;
  }

  /** Replace the code of a voter who has not registered (lost or leaked code). */
  async regenerateCode(eventId: string, voterId: string, actor: Actor): Promise<IssuedCode> {
    const event = await this.editableEvent(eventId);
    const voter = await EligibleVoter.findOne({ _id: voterId, eventId: event._id });
    if (!voter) throw AppError.notFound('Voter not found');
    if (voter.userId) throw AppError.conflict('This voter has already registered');

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      try {
        // Upsert so the same call works for "first code" and "replace unused code".
        await VerificationCode.updateOne(
          { eligibleVoterId: voter._id, used: false },
          {
            $set: { codeHash: hashCode(code, this.pepper) },
            $setOnInsert: { eventId: event._id },
          },
          { upsert: true },
        );
      } catch (err) {
        const dup = (err as { code?: number }).code === 11000;
        if (!dup) throw err;
        // Either a hash collision (retry) or the voter's code is already used (conflict).
        if (await VerificationCode.exists({ eligibleVoterId: voter._id, used: true })) {
          throw AppError.conflict('This voter\'s code has already been used');
        }
        continue;
      }
      await audit({
        action: 'code.regenerated',
        actorId: actor.id,
        actorRole: actor.role,
        ip: actor.ip,
        target: `event:${eventId}`,
        meta: { voterId },
      });
      return {
        voterId,
        fullName: voter.fullName,
        email: voter.email ?? '',
        nationalIdLast4: voter.nationalIdLast4,
        code,
      };
    }
    throw new Error('Could not generate a unique code');
  }
}
