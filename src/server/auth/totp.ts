import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes unpadded or padded base32 (case-insensitive). Throws on invalid characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 encoded (32 characters). */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function stepAt(date: Date): number {
  return Math.floor(date.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The 6-digit code valid at `date`. */
export function totpAt(secret: string, date: Date): string {
  return codeForStep(secret, stepAt(date));
}

/**
 * Verify `code` within +-1 step of `now`. Returns the matched step, or null when the code is wrong or
 * its step is <= `lastStep` (replay). All three candidates are always compared, in constant time.
 */
export function verifyTotp(secret: string, code: string, now: Date, lastStep: number): number | null {
  const given = Buffer.from(/^\d{6}$/.test(code) ? code : '------');
  const current = stepAt(now);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(codeForStep(secret, step));
    if (timingSafeEqual(given, expected) && step > lastStep && matched === null) matched = step;
  }
  return matched;
}

export function otpauthUri(secret: string, account = 'xo', issuer = 'XO'): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
}
