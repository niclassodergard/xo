import { describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './password.ts';

const probe = vi.hoisted(() => ({ active: 0, max: 0 }));
vi.mock('node:crypto', async (orig) => {
  const real = await orig<typeof import('node:crypto')>();
  return {
    ...real,
    scrypt: (...args: unknown[]) => {
      const cb = args.pop() as (e: Error | null, k: Buffer) => void;
      probe.active++;
      probe.max = Math.max(probe.max, probe.active);
      (real.scrypt as (...a: unknown[]) => void)(...args, (e: Error | null, k: Buffer) => { probe.active--; cb(e, k); });
    },
  };
});

const FAST = { N: 16, r: 8, p: 1 };

describe('password hashing', () => {
  it('round-trips and uses the documented format with default parameters', async () => {
    const stored = await hashPassword('correct horse battery');
    const [scheme, n, r, p, salt, hash] = stored.split('$');
    expect([scheme, n, r, p]).toEqual(['scrypt', String(2 ** 17), '8', '1']);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(hash!, 'base64')).toHaveLength(64);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery', FAST);
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('uses a fresh salt per hash', async () => {
    expect(await hashPassword('same', FAST)).not.toBe(await hashPassword('same', FAST));
  });

  it('rejects tampered or malformed stored strings without throwing', async () => {
    const stored = await hashPassword('pw', FAST);
    const parts = stored.split('$');
    const flipped = parts.slice(0, 5).concat([Buffer.alloc(64, 1).toString('base64')]).join('$');
    const bad = [
      '', 'garbage', 'scrypt$16$8$1$AAAA', stored + '$extra', 'bcrypt' + stored.slice(6),
      flipped,
      [parts[0], '17', parts[2], parts[3], parts[4], parts[5]].join('$'), // N not a power of two
      [parts[0], String(2 ** 30), parts[2], parts[3], parts[4], parts[5]].join('$'), // memory bomb
      [parts[0], parts[1], '999', parts[3], parts[4], parts[5]].join('$'),
      [parts[0], parts[1], parts[2], parts[3], parts[4], 'AAAA'].join('$'), // short hash
    ];
    for (const s of bad) expect(await verifyPassword('pw', s)).toBe(false);
  });

  it('runs at most one scrypt at a time, however many logins are concurrent', async () => {
    const stored = await hashPassword('pw', FAST);
    probe.active = 0;
    probe.max = 0;
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => verifyPassword('pw', stored)),
      hashPassword('other', FAST),
      verifyPassword('nope', stored),
    ]);
    expect(probe.max).toBe(1);
    expect(results.slice(0, 6)).toEqual(Array(6).fill(true));
    expect(results[7]).toBe(false);
  });
});
