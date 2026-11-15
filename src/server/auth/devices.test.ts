import { describe, expect, it } from 'vitest';
import { makeTestDb } from '../../../test/helpers.ts';
import { createDevice, deleteAllDevices, deleteDevice, deviceCookieName, lookupDevice, purgeExpiredDevices } from './devices.ts';
import { hashToken } from './sessions.ts';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const YEAR = 365 * 86_400_000;
const count = (db: ReturnType<typeof makeTestDb>) => (db.prepare('SELECT COUNT(*) AS c FROM devices').get() as { c: number }).c;

describe('devices', () => {
  it('stores only the hash of the token and returns the hash as the device id', () => {
    const db = makeTestDb();
    const token = createDevice(db, T0);
    const rows = db.prepare('SELECT * FROM devices').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(lookupDevice(db, token, T0)).toBe(hashToken(token));
  });

  it('rejects unknown, empty, oversized and non-string tokens', () => {
    const db = makeTestDb();
    createDevice(db, T0);
    for (const t of ['nope', '', 'x'.repeat(300), undefined, 5, null]) expect(lookupDevice(db, t, T0)).toBeNull();
  });

  it('expires after a year, with the boundary at expires_at <= now', () => {
    const db = makeTestDb();
    const token = createDevice(db, T0);
    expect(lookupDevice(db, token, new Date(T0.getTime() + YEAR - 1))).not.toBeNull();
    expect(lookupDevice(db, token, new Date(T0.getTime() + YEAR))).toBeNull();
  });

  it('purges expired rows, keeps live ones, and treats the boundary as expired', () => {
    const db = makeTestDb();
    createDevice(db, T0);
    const live = createDevice(db, new Date(T0.getTime() + 10 * 86_400_000));
    purgeExpiredDevices(db, new Date(T0.getTime() + YEAR - 1));
    expect(count(db)).toBe(2);
    purgeExpiredDevices(db, new Date(T0.getTime() + YEAR));
    expect(count(db)).toBe(1);
    expect(lookupDevice(db, live, new Date(T0.getTime() + YEAR))).toBe(hashToken(live));
  });

  it('deletes one or all devices and names the cookie from config', () => {
    const db = makeTestDb();
    const a = createDevice(db, T0);
    createDevice(db, T0);
    deleteDevice(db, hashToken(a));
    expect(count(db)).toBe(1);
    deleteAllDevices(db);
    expect(count(db)).toBe(0);
    expect(deviceCookieName({ cookieInsecure: false })).toBe('__Host-xo_device');
    expect(deviceCookieName({ cookieInsecure: true })).toBe('xo_device');
  });
});
