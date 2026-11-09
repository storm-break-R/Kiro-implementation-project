import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

// No 0/O/1/I to avoid transcription mistakes. Exactly 32 symbols, so 256 % 32 === 0
// and mapping a random byte to a symbol has no modulo bias.
const CODE_SYMBOLS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Cryptographically random verification code, e.g. "K7QM2-XR4TN-8PWD3" (75 bits). */
export function generateCode(groups = 3, groupLength = 5): string {
  const total = groups * groupLength;
  const bytes = randomBytes(total);
  const chars: string[] = [];
  for (let i = 0; i < total; i++) {
    chars.push(CODE_SYMBOLS[bytes[i]! % 32]!);
  }
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    parts.push(chars.slice(g * groupLength, (g + 1) * groupLength).join(''));
  }
  return parts.join('-');
}

/** Normalize user-typed codes: trim, upper-case, drop separators/spaces. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

/** Keyed hash (HMAC-SHA256) so values can be looked up without storing plaintext. */
export function hmacHex(value: string, pepper: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function hashCode(code: string, pepper: string): string {
  return hmacHex(`code:${normalizeCode(code)}`, pepper);
}

export function normalizeNationalId(id: string): string {
  return id.replace(/[\s-]/g, '').toUpperCase();
}

export function hashNationalId(id: string, pepper: string): string {
  return hmacHex(`nid:${normalizeNationalId(id)}`, pepper);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** AES-256-GCM. Output format: iv.tag.ciphertext (base64url). */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, enc].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string, keyHex: string): string {
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  if (!iv || !tag || !enc) throw new Error('Malformed ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
