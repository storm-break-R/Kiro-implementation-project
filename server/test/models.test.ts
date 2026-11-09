import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EligibleVoter, Participation, User, VerificationCode, Ballot } from '../src/models/index.js';
import { connectTestDb, disconnectTestDb } from './helpers/db.js';

const oid = () => new Types.ObjectId();

describe('model unique indexes', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it('rejects duplicate user emails (case-insensitive via lowercase)', async () => {
    await User.create({ email: 'A@x.com', passwordHash: 'h', role: 'voter' });
    await expect(User.create({ email: 'a@x.com', passwordHash: 'h', role: 'voter' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('rejects a second eligible voter row with the same ID in an event, allows other events', async () => {
    const eventId = oid();
    const row = { fullName: 'A', nationalIdHash: 'h1', nationalIdLast4: '1234', dateOfBirth: new Date('1990-01-01') };
    await EligibleVoter.create({ ...row, eventId });
    await expect(EligibleVoter.create({ ...row, eventId })).rejects.toMatchObject({ code: 11000 });
    await expect(EligibleVoter.create({ ...row, eventId: oid() })).resolves.toBeDefined();
  });

  it('allows only one verification code per voter and unique code hashes', async () => {
    const eventId = oid();
    const eligibleVoterId = oid();
    await VerificationCode.create({ eventId, eligibleVoterId, codeHash: 'c1' });
    await expect(VerificationCode.create({ eventId, eligibleVoterId, codeHash: 'c2' })).rejects.toMatchObject({
      code: 11000,
    });
    await expect(
      VerificationCode.create({ eventId, eligibleVoterId: oid(), codeHash: 'c1' }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('allows one participation per user per event', async () => {
    const eventId = oid();
    const userId = oid();
    await Participation.create({ eventId, userId });
    await expect(Participation.create({ eventId, userId })).rejects.toMatchObject({ code: 11000 });
  });

  it('supports multi-document transactions (replica set) and rolls back on failure', async () => {
    const eventId = oid();
    const userId = oid();
    await Participation.create({ eventId, userId });

    const session = await mongoose.startSession();
    await expect(
      session.withTransaction(async () => {
        await Ballot.create([{ eventId, candidateId: oid(), bucket: new Date() }], { session });
        await Participation.create([{ eventId, userId }], { session }); // duplicate -> abort
      }),
    ).rejects.toMatchObject({ code: 11000 });
    await session.endSession();

    expect(await Ballot.countDocuments({ eventId })).toBe(0);
  });

  it('ballots carry no voter reference and no precise timestamp', () => {
    const paths = Object.keys(Ballot.schema.paths);
    expect(paths).not.toContain('userId');
    expect(paths).not.toContain('createdAt');
    expect(paths).not.toContain('updatedAt');
    expect(Object.keys(Participation.schema.paths)).not.toContain('createdAt');
  });
});
