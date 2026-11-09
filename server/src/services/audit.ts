import { createHash } from 'node:crypto';
import { AuditLog } from '../models/auditLog.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntryInput {
  action: string;
  actorId?: string;
  actorRole?: string;
  target?: string;
  ip?: string;
  meta?: Record<string, unknown>;
}

export interface HashableEntry {
  seq: number;
  ts: Date;
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  target?: string | null;
  ip?: string | null;
  meta?: unknown;
  prevHash: string;
}

const SENSITIVE_KEY = /password|secret|token|totp|codehash|plaintext|^codes?$/i;

/** Deterministic JSON (sorted keys) so hashes survive a database round trip. */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Drop secret-looking fields so they can never reach the log. */
export function redactMeta(meta: unknown): unknown {
  if (Array.isArray(meta)) return meta.map(redactMeta);
  if (meta && typeof meta === 'object' && !(meta instanceof Date)) {
    return Object.fromEntries(
      Object.entries(meta as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[redacted]' : redactMeta(v),
      ]),
    );
  }
  return meta;
}

export function computeEntryHash(entry: HashableEntry): string {
  const payload = JSON.stringify([
    entry.seq,
    entry.ts.toISOString(),
    entry.actorId ?? null,
    entry.actorRole ?? null,
    entry.action,
    entry.target ?? null,
    entry.ip ?? null,
    stableStringify(entry.meta ?? {}),
    entry.prevHash,
  ]);
  return createHash('sha256').update(payload).digest('hex');
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  brokenAtSeq?: number;
  reason?: string;
}

/** Walk the whole chain and recompute every hash and link. */
export function verifyEntries(
  entries: Array<HashableEntry & { hash: string }>,
  startPrevHash = GENESIS_HASH,
  startSeq = 1,
): ChainVerification {
  let prev = startPrevHash;
  let expectedSeq = startSeq;
  let checked = 0;
  for (const e of entries) {
    if (e.seq !== expectedSeq) {
      return { valid: false, checked, brokenAtSeq: expectedSeq, reason: 'missing entry' };
    }
    if (e.prevHash !== prev) {
      return { valid: false, checked, brokenAtSeq: e.seq, reason: 'broken link' };
    }
    if (computeEntryHash(e) !== e.hash) {
      return { valid: false, checked, brokenAtSeq: e.seq, reason: 'hash mismatch' };
    }
    prev = e.hash;
    expectedSeq++;
    checked++;
  }
  return { valid: true, checked };
}

// Serialize appends within this process. Across processes the unique `seq` index plus
// retry keeps the chain linear.
let queue: Promise<unknown> = Promise.resolve();

async function appendOnce(input: AuditEntryInput) {
  const last = await AuditLog.findOne().sort({ seq: -1 }).lean();
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const ts = new Date();
  const meta = redactMeta(input.meta ?? {});
  const hash = computeEntryHash({
    seq,
    ts,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: input.action,
    target: input.target,
    ip: input.ip,
    meta,
    prevHash,
  });
  return AuditLog.create({
    seq,
    ts,
    actorId: input.actorId,
    actorRole: input.actorRole,
    action: input.action,
    target: input.target,
    ip: input.ip,
    meta,
    prevHash,
    hash,
  });
}

export function audit(input: AuditEntryInput): Promise<void> {
  const run = async (): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      try {
        await appendOnce(input);
        return;
      } catch (err) {
        const duplicate = (err as { code?: number }).code === 11000;
        if (!duplicate || attempt >= 5) throw err;
      }
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export async function verifyAuditChain(): Promise<ChainVerification> {
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  let checked = 0;
  const cursor = AuditLog.find().sort({ seq: 1 }).lean().cursor();
  for await (const doc of cursor) {
    const result = verifyEntries(
      [
        {
          seq: doc.seq,
          ts: doc.ts,
          actorId: doc.actorId,
          actorRole: doc.actorRole,
          action: doc.action,
          target: doc.target,
          ip: doc.ip,
          meta: doc.meta,
          prevHash: doc.prevHash,
          hash: doc.hash,
        },
      ],
      prev,
      expectedSeq,
    );
    if (!result.valid) return { ...result, checked };
    prev = doc.hash;
    expectedSeq++;
    checked++;
  }
  return { valid: true, checked };
}
