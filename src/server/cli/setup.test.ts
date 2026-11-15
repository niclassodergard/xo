import { describe, expect, it } from 'vitest';
import { makeTestDb } from '../../../test/helpers.ts';
import { verifyPassword } from '../auth/password.ts';
import { createDevice } from '../auth/devices.ts';
import { createSession } from '../auth/sessions.ts';
import { base32Encode, generateSecret, stepAt, totpAt } from '../auth/totp.ts';
import { setupUser } from './setup.ts';

const NOW = new Date('2026-01-15T12:00:00Z');
const FAST = { N: 16, r: 8, p: 1 };
const PW = 'a long enough password';

type UserRow = { password_hash: string; totp_secret: string; totp_last_step: number };
const row = (db: ReturnType<typeof makeTestDb>) => db.prepare('SELECT * FROM user').get() as UserRow | undefined;

describe('setupUser', () => {
  it('writes the user row after a valid confirming code, marking that step used', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    await setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, scryptParams: FAST });
    const u = row(db)!;
    expect(u.totp_secret).toBe(secret);
    expect(u.totp_last_step).toBe(stepAt(NOW));
    expect(u.password_hash.startsWith('scrypt$16$8$1$')).toBe(true);
    expect(await verifyPassword(PW, u.password_hash)).toBe(true);
    expect(u.password_hash).not.toContain(PW);
  });

  it('writes nothing for a wrong code or a short password', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    const good = totpAt(secret, NOW);
    const wrong = good === '000000' ? '000001' : '000000';
    await expect(setupUser(db, { password: PW, secret, code: wrong, now: NOW, scryptParams: FAST })).rejects.toThrow(/code/);
    await expect(setupUser(db, { password: 'short', secret, code: good, now: NOW, scryptParams: FAST })).rejects.toThrow(/at least 12/);
    await expect(setupUser(db, { password: PW, secret: '!!!', code: good, now: NOW, scryptParams: FAST })).rejects.toThrow();
    expect(row(db)).toBeUndefined();
  });

  it('refuses to replace an existing user without force', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    await setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, scryptParams: FAST });
    const later = new Date(NOW.getTime() + 60_000);
    const secret2 = generateSecret();
    await expect(setupUser(db, { password: 'another long password', secret: secret2, code: totpAt(secret2, later), now: later, scryptParams: FAST }))
      .rejects.toThrow(/--force/);
    expect(row(db)!.totp_secret).toBe(secret);
  });

  it('--force replaces the credentials and deletes all sessions', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    await setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, scryptParams: FAST });
    createSession(db, { sessionTtlDays: 30 }, NOW);
    createSession(db, { sessionTtlDays: 30 }, NOW);
    createDevice(db, NOW);
    const later = new Date(NOW.getTime() + 60_000);
    const secret2 = generateSecret();
    await setupUser(db, { password: 'another long password', secret: secret2, code: totpAt(secret2, later), now: later, force: true, scryptParams: FAST });
    const u = row(db)!;
    expect(u.totp_secret).toBe(secret2);
    expect(await verifyPassword('another long password', u.password_hash)).toBe(true);
    expect(await verifyPassword(PW, u.password_hash)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM devices').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM user').get()).toEqual({ c: 1 });
  });

  it('does not delete sessions when the first user is created', async () => {
    const db = makeTestDb();
    createSession(db, { sessionTtlDays: 30 }, NOW);
    const secret = generateSecret();
    await setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, scryptParams: FAST });
    expect(db.prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 1 });
  });

  it('--force on an empty database still works', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    await setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, force: true, scryptParams: FAST });
    expect(row(db)!.totp_secret).toBe(secret);
  });

  it('strips whitespace from the code', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    const c = totpAt(secret, NOW);
    await setupUser(db, { password: PW, secret, code: ` ${c.slice(0, 3)} ${c.slice(3)}\n`, now: NOW, scryptParams: FAST });
    expect(row(db)).toBeDefined();
  });

  it('rejects secrets that decode to fewer than 16 bytes', async () => {
    const db = makeTestDb();
    const secret = base32Encode(Buffer.alloc(15, 7));
    await expect(setupUser(db, { password: PW, secret, code: totpAt(secret, NOW), now: NOW, scryptParams: FAST })).rejects.toThrow(/secret/);
    const ok = base32Encode(Buffer.alloc(16, 7));
    await setupUser(db, { password: PW, secret: ok, code: totpAt(ok, NOW), now: NOW, scryptParams: FAST });
    expect(row(db)).toBeDefined();
  });

  it('caps the password at 256 characters', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    const code = totpAt(secret, NOW);
    await expect(setupUser(db, { password: 'x'.repeat(257), secret, code, now: NOW, scryptParams: FAST })).rejects.toThrow(/at most 256/);
    await setupUser(db, { password: 'x'.repeat(256), secret, code, now: NOW, scryptParams: FAST });
    expect(row(db)).toBeDefined();
  });

  it('counts the minimum password length in code points', async () => {
    const db = makeTestDb();
    const secret = generateSecret();
    const code = totpAt(secret, NOW);
    // 6 emoji are 12 UTF-16 units but only 6 characters.
    await expect(setupUser(db, { password: '\u{1F600}'.repeat(6), secret, code, now: NOW, scryptParams: FAST })).rejects.toThrow(/at least 12/);
    await setupUser(db, { password: '\u{1F600}'.repeat(12), secret, code, now: NOW, scryptParams: FAST });
    expect(row(db)).toBeDefined();
  });
});
