import { describe, expect, it } from 'vitest';
import { DEV_ENCRYPTION_KEY, loadEnv } from '../src/config/env.js';
import {
  decrypt,
  encrypt,
  generateCode,
  hashCode,
  hashNationalId,
  normalizeCode,
} from '../src/utils/crypto.js';

const PEPPER = 'p'.repeat(40);

describe('verification codes', () => {
  it('generates 15 symbols in 3 groups from the unambiguous alphabet', () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  });

  it('generates distinct codes', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateCode()));
    expect(codes.size).toBe(2000);
  });

  it('hashes regardless of case, spaces and dashes, and depends on the pepper', () => {
    expect(hashCode('abcde-fghjk-23456', PEPPER)).toBe(hashCode(' ABCDEFGHJK 23456 ', PEPPER));
    expect(hashCode('ABCDE', PEPPER)).not.toBe(hashCode('ABCDE', 'q'.repeat(40)));
    expect(normalizeCode('ab-cd ef')).toBe('ABCDEF');
  });

  it('hashes national IDs with normalization and domain separation from codes', () => {
    expect(hashNationalId('ab 12-34', PEPPER)).toBe(hashNationalId('AB1234', PEPPER));
    expect(hashNationalId('ABCDE', PEPPER)).not.toBe(hashCode('ABCDE', PEPPER));
  });
});

describe('encryption', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const a = encrypt('JBSWY3DPEHPK3PXP', DEV_ENCRYPTION_KEY);
    const b = encrypt('JBSWY3DPEHPK3PXP', DEV_ENCRYPTION_KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, DEV_ENCRYPTION_KEY)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('fails on tampering or the wrong key', () => {
    const enc = encrypt('secret', DEV_ENCRYPTION_KEY);
    expect(() => decrypt(enc, 'ff'.repeat(32))).toThrow();
    expect(() => decrypt(enc.slice(0, -2) + 'AA', DEV_ENCRYPTION_KEY)).toThrow();
  });
});

describe('production env safety', () => {
  it('refuses dev default secrets in production', () => {
    expect(() => loadEnv({ NODE_ENV: 'production' })).toThrow(/must be set to a unique secret/);
  });

  it('accepts explicit secrets in production', () => {
    const env = loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(40),
      CODE_PEPPER: 'c'.repeat(40),
      ENCRYPTION_KEY: 'ab'.repeat(32),
    });
    expect(env.NODE_ENV).toBe('production');
  });
});
