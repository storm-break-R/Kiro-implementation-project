import argon2 from 'argon2';
import { User } from '../models/user.js';
import { audit } from './audit.js';

export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export interface SeedResult {
  created: boolean;
  email: string;
}

/** Create the first admin if none exists. Idempotent. */
export async function seedAdmin(email?: string, password?: string): Promise<SeedResult> {
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set to seed the first admin');
  }
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
  const normalized = email.trim().toLowerCase();

  const existing = await User.findOne({ role: 'admin' });
  if (existing) {
    return { created: false, email: existing.email };
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await User.create({ email: normalized, passwordHash, role: 'admin' });
  await audit({
    action: 'admin.seeded',
    actorRole: 'system',
    target: `user:${admin._id.toString()}`,
    meta: { email: normalized },
  });
  return { created: true, email: normalized };
}
