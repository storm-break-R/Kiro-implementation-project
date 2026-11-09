import { AuditLog } from './auditLog.js';
import { Candidate } from './candidate.js';
import { EligibleVoter } from './eligibleVoter.js';
import { VotingEvent } from './event.js';
import { User } from './user.js';
import { VerificationCode } from './verificationCode.js';
import { Ballot, Participation } from './voting.js';

export * from './auditLog.js';
export * from './candidate.js';
export * from './eligibleVoter.js';
export * from './event.js';
export * from './user.js';
export * from './verificationCode.js';
export * from './voting.js';

/** Build all indexes (unique constraints are load-bearing for correctness). */
export async function syncIndexes(): Promise<void> {
  await Promise.all(
    [User, VotingEvent, Candidate, EligibleVoter, VerificationCode, Participation, Ballot, AuditLog].map(
      (m) => m.syncIndexes(),
    ),
  );
}
