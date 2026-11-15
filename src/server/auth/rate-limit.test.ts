import { describe, expect, it } from 'vitest';
import { createLoginLimiter } from './rate-limit.ts';

function setup(opts: { perIpMax?: number; globalMax?: number; perDeviceMax?: number } = {}) {
  let t = 1_000_000;
  const limiter = createLoginLimiter({ now: () => new Date(t), ...opts });
  return { limiter, advance: (ms: number) => { t += ms; } };
}

describe('login limiter', () => {
  it('allows 5 failures per IP and blocks the 6th with a retry time', () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) expect(limiter.attempt('1.1.1.1').allowed).toBe(true);
    const r = limiter.attempt('1.1.1.1');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(900);
    expect(limiter.attempt('2.2.2.2').allowed).toBe(true);
  });

  it('does not extend the lockout by blocked attempts and recovers after the window', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i++) limiter.attempt('a');
    advance(600_000);
    expect(limiter.attempt('a')).toEqual({ allowed: false, retryAfterSeconds: 300 });
    advance(300_000);
    expect(limiter.attempt('a').allowed).toBe(true);
  });

  it('enforces the global limit across IPs', () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) expect(limiter.attempt(`10.0.0.${i % 10}`).allowed).toBe(true);
    const r = limiter.attempt('9.9.9.9');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('gives an attempt back on success', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.attempt('a');
    expect(limiter.attempt('a').allowed).toBe(true);
    limiter.succeed('a');
    expect(limiter.attempt('a').allowed).toBe(true);
    expect(limiter.attempt('a').allowed).toBe(false);
  });

  it('smoke test: still serves new IPs after thousands of one-off IPs have expired', () => {
    const { limiter, advance } = setup({ globalMax: 1_000_000, perIpMax: 5 });
    for (let i = 0; i < 3000; i++) limiter.attempt(`ip${i}`);
    advance(16 * 60_000);
    expect(limiter.attempt('fresh').allowed).toBe(true);
  });

  it('a trusted device has its own bucket: not blocked by a saturated global or IP limit', () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) limiter.attempt(`10.0.${i}.1`);
    expect(limiter.attempt('10.0.0.1').allowed).toBe(false);
    expect(limiter.attempt('10.0.0.1', 'dev1').allowed).toBe(true);
  });

  it('rate limits the device bucket itself (5 per window) without touching IP or global counts', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i++) expect(limiter.attempt('1.1.1.1', 'dev1').allowed).toBe(true);
    const r = limiter.attempt('1.1.1.1', 'dev1');
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(900);
    expect(limiter.attempt('1.1.1.1', 'dev2').allowed).toBe(true);
    // The anonymous bucket for the same IP is untouched.
    for (let i = 0; i < 5; i++) expect(limiter.attempt('1.1.1.1').allowed).toBe(true);
    advance(900_000);
    expect(limiter.attempt('1.1.1.1', 'dev1').allowed).toBe(true);
  });

  it('succeed with a device gives back the device attempt only', () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i++) limiter.attempt('a', 'dev1');
    limiter.attempt('a', 'dev1');
    limiter.succeed('a', 'dev1');
    expect(limiter.attempt('a', 'dev1').allowed).toBe(true);
    expect(limiter.attempt('a', 'dev1').allowed).toBe(false);
  });
});
