import { createHash, createHmac, getRandomValues, timingSafeEqual } from 'node:crypto';

/** Canonical JSON: recursively sorted keys, `undefined` dropped, no insignificant whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = sortValue(record[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(payload: string | Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}

export function digestCanonical(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

export function hmacSha256Hex(secret: string, payload: string | Uint8Array): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/i.test(a) || !/^[0-9a-f]*$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom: number[] = [];

/** Monotonic ULID: sortable by creation time, unique within a process even in the same millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = incrementBase32(lastRandom);
  } else {
    lastTime = now;
    lastRandom = Array.from(getRandomValues(new Uint8Array(16)), (byte) => byte % 32);
  }
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  return time + lastRandom.map((digit) => ULID_ALPHABET[digit]).join('');
}

function incrementBase32(digits: number[]): number[] {
  const next = [...digits];
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const digit = next[i] ?? 0;
    if (digit < 31) {
      next[i] = digit + 1;
      return next;
    }
    next[i] = 0;
  }
  throw new Error('ULID random component overflowed within one millisecond');
}
