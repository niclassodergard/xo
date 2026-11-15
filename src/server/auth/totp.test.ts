import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, otpauthUri, stepAt, totpAt, verifyTotp } from './totp.ts';

// RFC 6238 Appendix B, SHA-1, seed "12345678901234567890"; the 8-digit codes truncated to 6 digits.
const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('totp', () => {
  it.each(VECTORS)('matches the RFC 6238 vector at t=%i', (t, code) => {
    expect(totpAt(SECRET, new Date(t * 1000))).toBe(code);
  });

  it('round-trips base32 and matches the RFC 4648 vector', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxw6ytboi======').toString()).toBe('foobar');
    const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => i * 13));
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
    expect(() => base32Decode('MZXW1')).toThrow();
  });

  it('generates 160-bit secrets', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(generateSecret()).not.toBe(s);
  });

  it('accepts the current step and +-1, rejects +-2', () => {
    const now = new Date(1111111111 * 1000);
    const cur = stepAt(now);
    const at = (d: number) => totpAt(SECRET, new Date((cur + d) * 30_000));
    expect(verifyTotp(SECRET, at(0), now, 0)).toBe(cur);
    expect(verifyTotp(SECRET, at(-1), now, 0)).toBe(cur - 1);
    expect(verifyTotp(SECRET, at(1), now, 0)).toBe(cur + 1);
    expect(verifyTotp(SECRET, at(-2), now, 0)).toBeNull();
    expect(verifyTotp(SECRET, at(2), now, 0)).toBeNull();
  });

  it('rejects replay of the same or an older step', () => {
    const now = new Date(1111111111 * 1000);
    const cur = stepAt(now);
    const code = totpAt(SECRET, now);
    expect(verifyTotp(SECRET, code, now, cur - 1)).toBe(cur);
    expect(verifyTotp(SECRET, code, now, cur)).toBeNull();
    expect(verifyTotp(SECRET, code, now, cur + 5)).toBeNull();
  });

  it('rejects malformed codes', () => {
    const now = new Date(1111111111 * 1000);
    for (const c of ['', '12345', '1234567', 'abcdef', ' 050471', '050471 ', '05047١']) {
      expect(verifyTotp(SECRET, c, now, 0)).toBeNull();
    }
  });

  it('builds the otpauth URI', () => {
    expect(otpauthUri('ABC234')).toBe('otpauth://totp/XO:xo?secret=ABC234&issuer=XO');
  });
});
