import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { hashToken } from './sessions.ts';

export const DEVICE_TTL_DAYS = 365;
const DAY_MS = 86_400_000;

export function deviceCookieName(config: Pick<Config, 'cookieInsecure'>): string {
  return config.cookieInsecure ? 'xo_device' : '__Host-xo_device';
}

/** Creates a trusted-device token; only its hash is stored. */
export function createDevice(db: DatabaseSync, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(now.getTime() + DEVICE_TTL_DAYS * DAY_MS).toISOString();
  db.prepare('INSERT INTO devices (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(token), now.toISOString(), expires);
  return token;
}

/** Returns the device's id (the token hash, never the token) if the token is known and unexpired. */
export function lookupDevice(db: DatabaseSync, token: unknown, now: Date): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return null;
  const hash = hashToken(token);
  const row = db.prepare('SELECT expires_at FROM devices WHERE token_hash = ?').get(hash) as { expires_at: string } | undefined;
  if (!row || Date.parse(row.expires_at) <= now.getTime()) return null;
  return hash;
}

export function deleteDevice(db: DatabaseSync, deviceId: string): void {
  db.prepare('DELETE FROM devices WHERE token_hash = ?').run(deviceId);
}

export function deleteAllDevices(db: DatabaseSync): void {
  db.exec('DELETE FROM devices');
}

export function purgeExpiredDevices(db: DatabaseSync, now: Date): void {
  db.prepare('DELETE FROM devices WHERE expires_at <= ?').run(now.toISOString());
}
