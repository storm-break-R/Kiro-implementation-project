import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/models/auditLog.js';
import { User } from '../src/models/user.js';
import {
  GENESIS_HASH,
  audit,
  computeEntryHash,
  redactMeta,
  stableStringify,
  verifyAuditChain,
  verifyEntries,
  type HashableEntry,
} from '../src/services/audit.js';
import { seedAdmin } from '../src/services/seed.js';
import { connectTestDb, disconnectTestDb } from './helpers/db.js';

function makeChain(n: number) {
  const entries: Array<HashableEntry & { hash: string }> = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const base: HashableEntry = {
      seq: i,
      ts: new Date(1_700_000_000_000 + i * 1000),
      actorId: 'a1',
      action: `act.${i}`,
      meta: { b: 2, a: 1 },
      prevHash: prev,
    };
    const hash = computeEntryHash(base);
    entries.push({ ...base, hash });
    prev = hash;
  }
  return entries;
}

describe('audit hash chain (pure)', () => {
  it('accepts an intact chain', () => {
    expect(verifyEntries(makeChain(5))).toEqual({ valid: true, checked: 5 });
  });

  it('detects a modified entry', () => {
    const chain = makeChain(5);
    chain[2]!.action = 'tampered';
    const result = verifyEntries(chain);
    expect(result.valid).toBe(false);
    expect(result.brokenAtSeq).toBe(3);
    expect(result.reason).toBe('hash mismatch');
  });

  it('detects a deleted entry', () => {
    const chain = makeChain(5);
    chain.splice(2, 1);
    const result = verifyEntries(chain);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing entry');
  });

  it('detects a re-linked entry', () => {
    const chain = makeChain(3);
    chain[1]!.prevHash = 'f'.repeat(64);
    expect(verifyEntries(chain).reason).toBe('broken link');
  });

  it('stableStringify ignores key order', () => {
    expect(stableStringify({ a: 1, b: { d: 1, c: 2 } })).toBe(
      stableStringify({ b: { c: 2, d: 1 }, a: 1 }),
    );
  });

  it('redacts secret-looking fields, including nested ones', () => {
    const out = redactMeta({
      email: 'a@b.c',
      password: 'x',
      nested: { refreshToken: 'y', ok: 1 },
      list: [{ totpSecret: 'z' }],
    }) as Record<string, unknown>;
    expect(out).toEqual({
      email: 'a@b.c',
      password: '[redacted]',
      nested: { refreshToken: '[redacted]', ok: 1 },
      list: [{ totpSecret: '[redacted]' }],
    });
  });
});

describe('audit service + seed (database)', () => {
  beforeAll(connectTestDb);
  afterAll(disconnectTestDb);

  it('appends linked entries that verify, even when written concurrently', async () => {
    await Promise.all(
      Array.from({ length: 15 }, (_, i) => audit({ action: 'test.event', meta: { i, password: 'p' } })),
    );
    const result = await verifyAuditChain();
    expect(result.valid).toBe(true);
    expect(result.checked).toBeGreaterThanOrEqual(15);
    const stored = await AuditLog.findOne({ action: 'test.event' }).lean();
    expect((stored!.meta as Record<string, unknown>).password).toBe('[redacted]');
  });

  it('detects tampering made directly in the database', async () => {
    await audit({ action: 'victim', target: 'x' });
    await mongoose.connection.collection('auditlogs').updateOne({ action: 'victim' }, {
      $set: { target: 'changed' },
    });
    const result = await verifyAuditChain();
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('hash mismatch');
  });

  it('seeds the first admin once, and audits it', async () => {
    const first = await seedAdmin('Admin@Example.com', 'a-very-long-password');
    expect(first).toEqual({ created: true, email: 'admin@example.com' });
    const second = await seedAdmin('other@example.com', 'another-long-password');
    expect(second.created).toBe(false);

    const admins = await User.find({ role: 'admin' }).lean();
    expect(admins).toHaveLength(1);
    expect(admins[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await AuditLog.countDocuments({ action: 'admin.seeded' })).toBe(1);
  });

  it('rejects weak or missing seed credentials', async () => {
    await expect(seedAdmin(undefined, undefined)).rejects.toThrow(/must be set/);
    await expect(seedAdmin('a@b.c', 'short')).rejects.toThrow(/at least/);
  });
});
