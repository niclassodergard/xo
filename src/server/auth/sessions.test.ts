import { describe, expect, it } from 'vitest';
import { makeTestDb } from '../../../test/helpers.ts';
import {
  createSession, deleteAllSessions, deleteSession, hashToken, lookupSession, purgeExpiredSessions, sessionCookieName,
} from './sessions.ts';

const config = { sessionTtlDays: 30, sessionIdleDays: 7 };
const T0 = new Date('2026-01-01T00:00:00.000Z');
const days = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const count = (db: ReturnType<typeof makeTestDb>) => (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;

describe('sessions', () => {
  it('stores only the hash of the token', () => {
    const db = makeTestDb();
    const { token, csrfToken } = createSession(db, config, T0);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(csrfToken).not.toBe(token);
    const rows = db.prepare('SELECT * FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('looks up a valid session and rejects unknown tokens', () => {
    const db = makeTestDb();
    const { token, csrfToken } = createSession(db, config, T0);
    expect(lookupSession(db, config, token, days(1))).toEqual({ csrfToken });
    expect(lookupSession(db, config, 'nope', days(1))).toBeNull();
  });

  it('expires absolutely after the TTL even when kept active', () => {
    const db = makeTestDb();
    const { token } = createSession(db, config, T0);
    for (let d = 5; d < 30; d += 5) expect(lookupSession(db, config, token, days(d))).not.toBeNull();
    expect(lookupSession(db, config, token, days(30))).toBeNull();
    expect(count(db)).toBe(0);
  });

  it('expires after the idle period and slides while in use', () => {
    const db = makeTestDb();
    const a = createSession(db, config, T0);
    expect(lookupSession(db, config, a.token, days(6))).not.toBeNull();
    expect(lookupSession(db, config, a.token, days(12))).not.toBeNull(); // touched at day 6
    const b = createSession(db, config, T0);
    expect(lookupSession(db, config, b.token, days(7))).toBeNull();
  });

  it('deletes one or all sessions', () => {
    const db = makeTestDb();
    const a = createSession(db, config, T0);
    createSession(db, config, T0);
    deleteSession(db, a.token);
    expect(lookupSession(db, config, a.token, T0)).toBeNull();
    expect(count(db)).toBe(1);
    deleteAllSessions(db);
    expect(count(db)).toBe(0);
  });

  it('purges expired and idle sessions only', () => {
    const db = makeTestDb();
    const old = createSession(db, config, T0);
    const fresh = createSession(db, config, days(20));
    expect(purgeExpiredSessions(db, config, days(21))).toBe(1);
    expect(lookupSession(db, config, old.token, days(21))).toBeNull();
    expect(lookupSession(db, config, fresh.token, days(21))).not.toBeNull();
  });

  it('names the cookie from config', () => {
    expect(sessionCookieName({ cookieInsecure: false })).toBe('__Host-xo_session');
    expect(sessionCookieName({ cookieInsecure: true })).toBe('xo_session');
  });

  it('throttles last_seen_at writes: skipped within 60 s, updated after', () => {
    const db = makeTestDb();
    const { token } = createSession(db, config, T0);
    const seen = () => (db.prepare('SELECT last_seen_at FROM sessions').get() as { last_seen_at: string }).last_seen_at;
    lookupSession(db, config, token, new Date(T0.getTime() + 59_000));
    expect(seen()).toBe(T0.toISOString());
    const later = new Date(T0.getTime() + 61_000);
    lookupSession(db, config, token, later);
    expect(seen()).toBe(later.toISOString());
  });
});
