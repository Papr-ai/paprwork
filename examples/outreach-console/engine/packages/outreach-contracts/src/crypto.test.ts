import { describe, expect, it } from 'vitest';
import { canonicalize, digestCanonical, hmacSha256Hex, safeEqualHex, sha256Hex, ulid } from './crypto';

describe('canonicalize', () => {
  it('is independent of key order and drops undefined', () => {
    expect(canonicalize({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      canonicalize({ a: { d: [2, { y: 2, z: 1 }] }, b: 1 }),
    );
    expect(digestCanonical({ a: 1, b: 2 })).toBe(digestCanonical({ b: 2, a: 1 }));
  });
});

describe('hashing', () => {
  it('produces known sha256 and hmac values', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('compares hex digests safely', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
    expect(safeEqualHex('abcd', 'abce')).toBe(false);
    expect(safeEqualHex('abcd', 'abc')).toBe(false);
    expect(safeEqualHex('zz', 'zz')).toBe(false);
  });
});

describe('ulid', () => {
  it('is 26 Crockford base32 characters and sorts by creation order', () => {
    const ids = Array.from({ length: 500 }, (_, i) => ulid(1_700_000_000_000 + Math.floor(i / 50)));
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
