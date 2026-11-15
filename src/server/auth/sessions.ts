import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';

const DAY_MS = 86_400_000;
/** last_seen_at is only rewritten when it is older than this (idle limits are days, not seconds). */
const TOUCH_INTERVAL_MS = 60_000;

export interface SessionInfo { csrfToken: string }

export function sessionCookieName(config: Pick<Config, 'cookieInsecure'>): string {
  return config.cookieInsecure ? 'xo_session' : '__Host-xo_session';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Creates a session; only the hash of the returned token is stored. */
export function createSession(
  db: DatabaseSync,
  config: Pick<Config, 'sessionTtlDays'>,
  now: Date,
): { token: string; csrfToken: string } {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  const iso = now.toISOString();
  const expires = new Date(now.getTime() + config.sessionTtlDays * DAY_MS).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), csrfToken, iso, iso, expires);
  return { token, csrfToken };
}

/** Returns the session if the token is valid, unexpired and not idle; touches last_seen_at. */
export function lookupSession(
  db: DatabaseSync,
  config: Pick<Config, 'sessionIdleDays'>,
  token: string,
  now: Date,
): SessionInfo | null {
  const hash = hashToken(token);
  const row = db.prepare('SELECT csrf_token, last_seen_at, expires_at FROM sessions WHERE token_hash = ?')
    .get(hash) as { csrf_token: string; last_seen_at: string; expires_at: string } | undefined;
  if (!row) return null;
  const nowMs = now.getTime();
  const lastSeen = Date.parse(row.last_seen_at);
  if (Date.parse(row.expires_at) <= nowMs || lastSeen + config.sessionIdleDays * DAY_MS <= nowMs) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }
  if (nowMs - lastSeen > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now.toISOString(), hash);
  }
  return { csrfToken: row.csrf_token };
}

export function deleteSession(db: DatabaseSync, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function deleteAllSessions(db: DatabaseSync): void {
  db.exec('DELETE FROM sessions');
}

/** Deletes absolutely expired and idle-expired sessions. Returns the number removed. */
export function purgeExpiredSessions(
  db: DatabaseSync,
  config: Pick<Config, 'sessionIdleDays'>,
  now: Date,
): number {
  const idleCutoff = new Date(now.getTime() - config.sessionIdleDays * DAY_MS).toISOString();
  const res = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?')
    .run(now.toISOString(), idleCutoff);
  return Number(res.changes);
}
