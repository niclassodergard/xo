import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface OpenDbOptions {
  /** Receives warnings (paths only). Default console.warn. */
  warn?: (message: string) => void;
}

/**
 * Open (creating if needed) the SQLite file. A missing directory is created 0700 and the file 0600.
 * An existing directory is never chmod'ed (it may be something like a home directory); if it is
 * group/world accessible a warning is printed and startup continues. Pass ':memory:' for tests.
 */
export function openDb(path: string, opts: OpenDbOptions = {}): DatabaseSync {
  if (path !== ':memory:') {
    const dir = dirname(path);
    const warn = opts.warn ?? console.warn;
    if (existsSync(dir)) {
      if ((statSync(dir).mode & 0o077) !== 0) {
        warn(`database directory ${dir} is accessible by group/others; consider chmod 700`);
      }
    } else {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Pre-create the file with 0600 so SQLite (and its -wal/-shm siblings) never start world-readable.
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // Deleted content is overwritten with zeros instead of lingering in free pages (purge relies on this).
  db.exec('PRAGMA secure_delete = ON');
  return db;
}
