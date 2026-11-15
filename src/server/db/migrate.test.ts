import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestDb } from '../../../test/helpers.ts';
import { currentVersion, latestVersion, migrate } from './migrate.ts';
import { openDb } from './open.ts';

const NOW = '2026-01-01T00:00:00Z';

describe('migrate', () => {
  it('fresh DB reaches the latest user_version', () => {
    const db = makeTestDb();
    expect(latestVersion()).toBeGreaterThanOrEqual(1);
    expect(currentVersion(db)).toBe(latestVersion());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['user', 'sessions', 'people', 'meetings', 'notes', 'actions', 'agenda_items', 'captures']) {
      expect(tables).toContain(t);
    }
  });

  it('re-running is a no-op', () => {
    const db = makeTestDb();
    db.prepare('INSERT INTO people (name, created_at, updated_at) VALUES (?, ?, ?)').run('Anna', NOW, NOW);
    expect(migrate(db)).toBe(latestVersion());
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
  });

  it('rejects a second active meeting for the same person but allows one after ending', () => {
    const db = makeTestDb();
    db.prepare('INSERT INTO people (name, created_at, updated_at) VALUES (?, ?, ?)').run('Anna', NOW, NOW);
    const ins = db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (1, ?)');
    ins.run(NOW);
    expect(() => ins.run(NOW)).toThrow(/UNIQUE/);
    db.prepare('UPDATE meetings SET ended_at = ? WHERE person_id = 1').run(NOW);
    expect(() => ins.run(NOW)).not.toThrow();
  });

  it('enforces foreign keys and check constraints', () => {
    const db = makeTestDb();
    expect(() => db.prepare("INSERT INTO meetings (person_id, started_at) VALUES (99, 'x')").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare("INSERT INTO actions (text, owner, created_at) VALUES ('x', 'you', 'x')").run()).toThrow(/CHECK/);
  });
});

describe('openDb', () => {
  it('creates the directory 0700 and file 0600 with WAL and foreign keys', () => {
    const base = mkdtempSync(join(tmpdir(), 'xo-test-'));
    try {
      const dir = join(base, 'data');
      const path = join(dir, 'xo.db');
      const db = openDb(path);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      db.close();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never chmods an existing directory; warns with the path only', () => {
    const base = mkdtempSync(join(tmpdir(), 'xo-test-'));
    try {
      const dir = join(base, 'data');
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      const warnings: string[] = [];
      openDb(join(dir, 'xo.db'), { warn: (m) => warnings.push(m) }).close();
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not warn for an existing 0700 directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'xo-test-'));
    try {
      const dir = join(base, 'data');
      mkdirSync(dir);
      chmodSync(dir, 0o700);
      const warnings: string[] = [];
      openDb(join(dir, 'xo.db'), { warn: (m) => warnings.push(m) }).close();
      expect(warnings).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('upgrade to migration 003', () => {
  const sqlOf = (name: string): string => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
  function v2Db() {
    const db = openDb(':memory:');
    db.exec(sqlOf('001-init.sql'));
    db.exec(sqlOf('002-devices.sql'));
    db.exec('PRAGMA user_version = 2');
    db.prepare('INSERT INTO people (name, created_at, updated_at) VALUES (?, ?, ?)').run('Anna', NOW, NOW);
    db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (1, ?)').run(NOW);
    const n = db.prepare('INSERT INTO notes (id, title, body_md, person_id, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 1, ?, ?, ?)');
    n.run(1, 'live', 'b1', NOW, NOW, null);
    n.run(2, 'gone', 'b2', NOW, NOW, NOW);
    n.run(4, 'top-deleted', 'b4', NOW, NOW, NOW);
    db.prepare("INSERT INTO actions (id, text, owner, person_id, meeting_id, created_at, deleted_at) VALUES (3, 'act', 'me', 1, 1, ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO agenda_items (id, person_id, text, created_at, deleted_at) VALUES (6, 1, 'ag', ?, ?)").run(NOW, NOW);
    return db;
  }

  it('keeps rows and ids, adds AUTOINCREMENT and the indexes, never reuses a deleted top id', () => {
    const db = v2Db();
    expect(migrate(db)).toBe(latestVersion());
    expect(db.prepare('SELECT id, title, deleted_at FROM notes ORDER BY id').all()).toEqual([
      { id: 1, title: 'live', deleted_at: null },
      { id: 2, title: 'gone', deleted_at: NOW },
      { id: 4, title: 'top-deleted', deleted_at: NOW },
    ]);
    expect(db.prepare('SELECT id, deleted_at FROM actions').all()).toEqual([{ id: 3, deleted_at: NOW }]);
    expect(db.prepare('SELECT id, deleted_at FROM agenda_items').all()).toEqual([{ id: 6, deleted_at: NOW }]);
    for (const t of ['notes', 'actions', 'agenda_items']) {
      expect((db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(t) as unknown as { sql: string }).sql).toContain('AUTOINCREMENT');
    }
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('notes_person','actions_open','agenda_person')").all() as unknown as { name: string }[]).map((r) => r.name).sort();
    expect(idx).toEqual(['actions_open', 'agenda_person', 'notes_person']);
    expect(db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('devices')).toBeDefined();
    db.prepare('DELETE FROM notes WHERE id = 4').run();
    const res = db.prepare("INSERT INTO notes (title, created_at, updated_at) VALUES ('new', ?, ?)").run(NOW, NOW);
    expect(Number(res.lastInsertRowid)).toBe(5);
  });

  it('fails and leaves version and data untouched when a dangling FK already exists', () => {
    const db = v2Db();
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare("INSERT INTO notes (id, title, person_id, created_at, updated_at) VALUES (9, 'dangling', 999, ?, ?)").run(NOW, NOW);
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => migrate(db)).toThrow();
    expect(currentVersion(db)).toBe(2);
    expect(db.prepare('SELECT id FROM notes ORDER BY id').all()).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }, { id: 9 }]);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'notes'").get() as unknown as { sql: string }).sql).not.toContain('AUTOINCREMENT');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_new'").all()).toEqual([]);
    expect(() => db.exec('BEGIN')).not.toThrow(); // no transaction left open
    db.exec('ROLLBACK');
  });
});
