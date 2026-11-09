import argon2 from 'argon2';
import mongoose from 'mongoose';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent } from '../models/event.js';
import { User } from '../models/user.js';
import { VerificationCode } from '../models/verificationCode.js';
import { isAdult } from '../utils/age.js';
import { hashCode, hashNationalId } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.js';
import type { AuthResult, AuthService, RequestMeta } from './auth.js';

export interface RegistrationInput {
  nationalId: string;
  code: string;
  email: string;
  password: string;
}

/** One message for every "your details don't check out" outcome, so nothing can be enumerated. */
const genericFailure = () =>
  new AppError(
    400,
    'REGISTRATION_FAILED',
    'We could not verify those details. Check your ID and verification code, or contact the organizer.',
  );

class RegistrationRejected extends Error {
  constructor(public readonly reason: string) {
    super(reason);
  }
}

export class RegistrationService {
  constructor(
    private readonly pepper: string,
    private readonly auth: AuthService,
  ) {}

  async register(input: RegistrationInput, meta: RequestMeta): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    try {
      return await this.attempt({ ...input, email }, meta);
    } catch (err) {
      if (err instanceof RegistrationRejected) {
        await audit({
          action: 'voter.registration_failed',
          ip: meta.ip,
          meta: { reason: err.reason },
        });
        if (err.reason === 'underage') {
          throw new AppError(403, 'UNDERAGE', 'You must be at least 18 years old to register to vote.');
        }
        throw genericFailure();
      }
      // A concurrent registration with the same email loses on the unique index.
      if ((err as { code?: number }).code === 11000) {
        await audit({ action: 'voter.registration_failed', ip: meta.ip, meta: { reason: 'duplicate_key' } });
        throw genericFailure();
      }
      throw err;
    }
  }

  private async attempt(input: RegistrationInput, meta: RequestMeta): Promise<AuthResult> {
    const codeDoc = await VerificationCode.findOne({ codeHash: hashCode(input.code, this.pepper) });
    if (!codeDoc) throw new RegistrationRejected('unknown_code');

    const voter = await EligibleVoter.findById(codeDoc.eligibleVoterId);
    if (!voter) throw new RegistrationRejected('unknown_voter');
    // The code must belong to the person whose ID was entered.
    if (voter.nationalIdHash !== hashNationalId(input.nationalId, this.pepper)) {
      throw new RegistrationRejected('id_mismatch');
    }
    if (codeDoc.used || voter.userId) throw new RegistrationRejected('code_used');

    const event = await VotingEvent.findById(voter.eventId);
    if (!event || event.status === 'closed') throw new RegistrationRejected('event_closed');
    if (!isAdult(voter.dateOfBirth)) throw new RegistrationRejected('underage');

    // Someone who is already registered for another event proves ownership with their password.
    const existing = await User.findOne({ email: input.email });
    if (existing) {
      const ok =
        existing.role === 'voter' &&
        (await argon2.verify(existing.passwordHash, input.password).catch(() => false));
      if (!ok) throw new RegistrationRejected('email_taken');
    }
    const passwordHash = existing ? existing.passwordHash : await this.auth.hashPassword(input.password);

    // Claim the code, create/link the account and mark the voter registered, all or nothing.
    // A second concurrent attempt with the same code hits a write conflict, retries, and then
    // finds the code already claimed.
    const userId = await mongoose.connection.transaction(async (session) => {
      const claimed = await VerificationCode.findOneAndUpdate(
        { _id: codeDoc._id, used: false },
        { $set: { used: true, usedAt: new Date() } },
        { session },
      );
      if (!claimed) throw new RegistrationRejected('code_used');

      let id = existing?._id;
      if (!id) {
        const [created] = await User.create([{ email: input.email, passwordHash, role: 'voter' }], { session });
        id = created!._id;
      }
      const linked = await EligibleVoter.findOneAndUpdate(
        { _id: voter._id, userId: { $exists: false } },
        { $set: { userId: id, registeredAt: new Date() } },
        { session },
      );
      if (!linked) throw new RegistrationRejected('code_used');
      await User.updateOne({ _id: id }, { $addToSet: { eligibleVoterIds: voter._id } }, { session });
      return id;
    });

    await audit({
      action: 'voter.registered',
      actorId: userId.toString(),
      actorRole: 'voter',
      ip: meta.ip,
      target: `event:${voter.eventId}`,
      meta: { linkedExistingAccount: !!existing },
    });
    return this.auth.startVoterSession({ id: userId.toString(), email: input.email }, meta);
  }
}
