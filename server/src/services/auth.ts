import argon2 from 'argon2';
import type { Redis } from 'ioredis';
import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import type { Env } from '../config/env.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent } from '../models/event.js';
import { User } from '../models/user.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { AppError } from '../utils/errors.js';
import { audit } from './audit.js';
import type { SessionService } from './sessions.js';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_SECONDS = 15 * 60;
const TOTP_ISSUER = 'Soccer Voting';

// Verified against when the email is unknown, so response time doesn't reveal which emails exist.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= argon2.hash('not-a-real-password', { type: argon2.argon2id });
  return dummyHash;
}

export interface RequestMeta {
  ip?: string;
}

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; role: 'admin' | 'voter'; mfaEnabled: boolean };
  /** Admin has authenticated with a password but must enroll TOTP before using admin features. */
  mfaEnrollmentRequired: boolean;
}

export class AuthService {
  constructor(
    private readonly env: Env,
    private readonly redis: Redis,
    private readonly sessions: SessionService,
  ) {}

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async login(
    input: { email: string; password: string; totpCode?: string },
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const email = input.email.trim().toLowerCase();
    const lockKey = `lf:${email}`;

    const failures = Number((await this.redis.get(lockKey)) ?? 0);
    if (failures >= MAX_FAILED_LOGINS) {
      await audit({ action: 'auth.login_locked', ip: meta.ip, meta: { email } });
      throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }

    const user = await User.findOne({ email });
    const passwordOk =
      (await argon2.verify(user?.passwordHash ?? (await getDummyHash()), input.password).catch(
        () => false,
      )) && !!user;

    const fail = async (reason: string): Promise<never> => {
      const count = await this.redis.incr(lockKey);
      if (count === 1) await this.redis.expire(lockKey, LOCKOUT_SECONDS);
      await audit({
        action: 'auth.login_failed',
        actorId: user?._id.toString(),
        ip: meta.ip,
        meta: { email, reason },
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    };

    if (!passwordOk || !user) return fail('bad_password');

    let mfaSatisfied = true;
    if (user.role === 'admin') {
      if (user.totpEnabled && user.totpSecretEnc) {
        if (!input.totpCode) {
          // Password was right; ask for the second factor without counting it as a failure.
          throw new AppError(401, 'MFA_REQUIRED', 'Authentication code required');
        }
        const ok = await this.checkTotp(user._id.toString(), user.totpSecretEnc, input.totpCode);
        if (!ok) return fail('bad_totp');
      } else {
        mfaSatisfied = false;
      }
    } else {
      await this.assertVoterEligible(user.eligibleVoterIds);
    }

    await this.redis.del(lockKey);
    const userId = user._id.toString();
    const { refreshToken, sid } = await this.sessions.createSession(userId, user.role, mfaSatisfied);
    await audit({
      action: 'auth.login',
      actorId: userId,
      actorRole: user.role,
      ip: meta.ip,
      meta: { mfa: mfaSatisfied },
    });
    return {
      accessToken: this.sessions.signAccess({ sub: userId, role: user.role, mfa: mfaSatisfied, sid }),
      refreshToken,
      user: { id: userId, email: user.email, role: user.role, mfaEnabled: user.totpEnabled },
      mfaEnrollmentRequired: user.role === 'admin' && !user.totpEnabled,
    };
  }

  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthResult> {
    const result = await this.sessions.rotate(refreshToken);
    if (result.status === 'reuse') {
      await audit({
        action: 'auth.refresh_reuse_detected',
        actorId: result.record.userId,
        actorRole: result.record.role,
        ip: meta.ip,
        meta: { sessionRevoked: true },
      });
      throw AppError.unauthorized('Session expired');
    }
    if (result.status === 'invalid') throw AppError.unauthorized('Session expired');

    const user = await User.findById(result.record.userId);
    if (!user) {
      await this.sessions.revokeSession(result.record.sid);
      throw AppError.unauthorized('Session expired');
    }
    const userId = user._id.toString();
    return {
      accessToken: this.sessions.signAccess({
        sub: userId,
        role: user.role,
        mfa: result.record.mfa,
        sid: result.record.sid,
      }),
      refreshToken: result.refreshToken,
      user: { id: userId, email: user.email, role: user.role, mfaEnabled: user.totpEnabled },
      mfaEnrollmentRequired: user.role === 'admin' && !user.totpEnabled,
    };
  }

  async logout(refreshToken: string, meta: RequestMeta): Promise<void> {
    const record = await this.sessions.revokeByRefreshToken(refreshToken);
    if (record) {
      await audit({
        action: 'auth.logout',
        actorId: record.userId,
        actorRole: record.role,
        ip: meta.ip,
      });
    }
  }

  /** Open a session for a voter who has just registered (their second factor is the voter code). */
  async startVoterSession(user: { id: string; email: string }, meta: RequestMeta): Promise<AuthResult> {
    const { refreshToken, sid } = await this.sessions.createSession(user.id, 'voter', true);
    await audit({ action: 'auth.login', actorId: user.id, actorRole: 'voter', ip: meta.ip, meta: { via: 'registration' } });
    return {
      accessToken: this.sessions.signAccess({ sub: user.id, role: 'voter', mfa: true, sid }),
      refreshToken,
      user: { id: user.id, email: user.email, role: 'voter', mfaEnabled: false },
      mfaEnrollmentRequired: false,
    };
  }

  /** Step 1 of TOTP enrollment: create (or replace) a pending secret and return the QR code. */
  async beginMfaSetup(userId: string, meta: RequestMeta) {
    const user = await User.findById(userId);
    if (!user || user.role !== 'admin') throw AppError.forbidden();
    if (user.totpEnabled) throw AppError.conflict('MFA is already enabled');

    const secret = generateSecret();
    user.totpSecretEnc = encrypt(secret, this.env.ENCRYPTION_KEY);
    await user.save();

    const otpauthUrl = generateURI({ issuer: TOTP_ISSUER, label: user.email, secret });
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    await audit({
      action: 'auth.mfa_setup_started',
      actorId: userId,
      actorRole: 'admin',
      ip: meta.ip,
    });
    return { secret, otpauthUrl, qrDataUrl };
  }

  /** Step 2: prove possession of the authenticator, enable MFA, and upgrade the session. */
  async completeMfaSetup(
    userId: string,
    currentSid: string,
    code: string,
    meta: RequestMeta,
  ): Promise<AuthResult> {
    const user = await User.findById(userId);
    if (!user || user.role !== 'admin') throw AppError.forbidden();
    if (user.totpEnabled) throw AppError.conflict('MFA is already enabled');
    if (!user.totpSecretEnc) throw AppError.badRequest('Start MFA setup first');

    const ok = await this.checkTotp(userId, user.totpSecretEnc, code);
    if (!ok) {
      await audit({
        action: 'auth.mfa_setup_failed',
        actorId: userId,
        actorRole: 'admin',
        ip: meta.ip,
      });
      throw new AppError(401, 'INVALID_MFA_CODE', 'Invalid authentication code');
    }

    user.totpEnabled = true;
    await user.save();
    await this.sessions.revokeSession(currentSid);
    const { refreshToken, sid } = await this.sessions.createSession(userId, 'admin', true);
    await audit({
      action: 'auth.mfa_enabled',
      actorId: userId,
      actorRole: 'admin',
      ip: meta.ip,
    });
    return {
      accessToken: this.sessions.signAccess({ sub: userId, role: 'admin', mfa: true, sid }),
      refreshToken,
      user: { id: userId, email: user.email, role: 'admin', mfaEnabled: true },
      mfaEnrollmentRequired: false,
    };
  }

  /** TOTP check with a +/-30s window and replay protection (a code works once). */
  private async checkTotp(userId: string, secretEnc: string, code: string): Promise<boolean> {
    let secret: string;
    try {
      secret = decrypt(secretEnc, this.env.ENCRYPTION_KEY);
    } catch {
      return false;
    }
    const result = verifySync({ secret, token: code, epochTolerance: 30 });
    if (!result.valid) return false;
    const claimed = await this.redis.set(`totp:${userId}:${code}`, '1', 'EX', 90, 'NX');
    return claimed === 'OK';
  }

  /** Voters must hold at least one registration for an event that has not closed yet. */
  private async assertVoterEligible(eligibleVoterIds: unknown[]): Promise<void> {
    if (eligibleVoterIds.length > 0) {
      const rows = await EligibleVoter.find({ _id: { $in: eligibleVoterIds } }, { eventId: 1 }).lean();
      const open = await VotingEvent.exists({
        _id: { $in: rows.map((r) => r.eventId) },
        status: { $ne: 'closed' },
      });
      if (open) return;
    }
    throw new AppError(403, 'NOT_ELIGIBLE', 'You are not eligible to vote in any current event');
  }
}
