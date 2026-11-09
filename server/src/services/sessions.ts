import jwt from 'jsonwebtoken';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import type { Role } from '../models/user.js';
import { randomToken, sha256Hex } from '../utils/crypto.js';

const ISSUER = 'soccer-voting';

export interface AccessClaims {
  sub: string;
  role: Role;
  /** True when the account's second-factor requirement is satisfied (always true for voters). */
  mfa: boolean;
  /** Session (refresh token family) id. Revoking the session invalidates the access token. */
  sid: string;
}

interface RefreshRecord {
  userId: string;
  role: Role;
  mfa: boolean;
  sid: string;
}

export type RotateResult =
  | { status: 'ok'; refreshToken: string; record: RefreshRecord }
  | { status: 'reuse'; record: RefreshRecord }
  | { status: 'invalid' };

/**
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random strings stored
 * (hashed) in Redis, rotated on every use. Presenting an already-used refresh token is treated
 * as theft: the whole session is revoked.
 */
export class SessionService {
  constructor(
    private readonly redis: Redis,
    private readonly env: Pick<
      Env,
      'JWT_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS' | 'REFRESH_TOKEN_TTL_SECONDS'
    >,
  ) {}

  signAccess(claims: AccessClaims): string {
    return jwt.sign({ role: claims.role, mfa: claims.mfa, sid: claims.sid }, this.env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: claims.sub,
      issuer: ISSUER,
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  /** Returns claims for a valid token whose session is still active, otherwise null. */
  async verifyAccess(token: string): Promise<AccessClaims | null> {
    try {
      const payload = jwt.verify(token, this.env.JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
      });
      if (typeof payload === 'string') return null;
      const { sub, role, mfa, sid } = payload as Record<string, unknown>;
      if (
        typeof sub !== 'string' ||
        (role !== 'admin' && role !== 'voter') ||
        typeof mfa !== 'boolean' ||
        typeof sid !== 'string'
      ) {
        return null;
      }
      if (!(await this.isSessionActive(sid))) return null;
      return { sub, role, mfa, sid };
    } catch {
      return null;
    }
  }

  async createSession(
    userId: string,
    role: Role,
    mfa: boolean,
  ): Promise<{ refreshToken: string; sid: string }> {
    const sid = randomToken(16);
    const refreshToken = await this.storeRefresh({ userId, role, mfa, sid });
    return { refreshToken, sid };
  }

  async rotate(refreshToken: string): Promise<RotateResult> {
    const h = sha256Hex(refreshToken);
    // GETDEL makes "consume the token" atomic, so concurrent refreshes cannot both succeed.
    const raw = await this.redis.getdel(`rt:${h}`);
    if (!raw) {
      const usedRaw = await this.redis.get(`used:${h}`);
      if (usedRaw) {
        const record = JSON.parse(usedRaw) as RefreshRecord;
        await this.revokeSession(record.sid);
        return { status: 'reuse', record };
      }
      return { status: 'invalid' };
    }
    const record = JSON.parse(raw) as RefreshRecord;
    if (!(await this.isSessionActive(record.sid))) return { status: 'invalid' };
    await this.redis.set(
      `used:${h}`,
      JSON.stringify(record),
      'EX',
      this.env.REFRESH_TOKEN_TTL_SECONDS,
    );
    const next = await this.storeRefresh(record);
    return { status: 'ok', refreshToken: next, record };
  }

  /** Revoke the session that a refresh token belongs to (logout). Returns its record if known. */
  async revokeByRefreshToken(refreshToken: string): Promise<RefreshRecord | null> {
    const h = sha256Hex(refreshToken);
    const raw = (await this.redis.get(`rt:${h}`)) ?? (await this.redis.get(`used:${h}`));
    if (!raw) return null;
    const record = JSON.parse(raw) as RefreshRecord;
    await this.revokeSession(record.sid);
    return record;
  }

  async revokeSession(sid: string): Promise<void> {
    const current = await this.redis.get(`sess:${sid}`);
    if (current) await this.redis.del(`rt:${current}`);
    await this.redis.del(`sess:${sid}`);
  }

  async isSessionActive(sid: string): Promise<boolean> {
    return (await this.redis.exists(`sess:${sid}`)) === 1;
  }

  private async storeRefresh(record: RefreshRecord): Promise<string> {
    const token = randomToken(32);
    const h = sha256Hex(token);
    const ttl = this.env.REFRESH_TOKEN_TTL_SECONDS;
    await this.redis.set(`rt:${h}`, JSON.stringify(record), 'EX', ttl);
    await this.redis.set(`sess:${record.sid}`, h, 'EX', ttl);
    return token;
  }
}
