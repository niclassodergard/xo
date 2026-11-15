import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, migrate } from './migrate.ts';
import { openDb } from './open.ts';

const TS = '2026-01-01T00:00:00.000Z';
const sql = (name: string): string => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');

describe('openDb', () => {
  it('turns secure_delete and foreign_keys on', () => {
    const db = openDb(':memory:');
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});

describe('migration 003 (AUTOINCREMENT for notes, actions, agenda_items)', () => {
  function oldDb() {
    const db = openDb(':memory:');
    db.exec(sql('001-init.sql'));
    db.exec('PRAGMA user_version = 1');
    db.prepare('INSERT INTO people (name, created_at, updated_at) VALUES (?, ?, ?)').run('Anna', TS, TS);
    db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (1, ?)').run(TS);
    db.prepare('INSERT INTO notes (id, title, body_md, person_id, created_at, updated_at, deleted_at) VALUES (5, ?, ?, 1, ?, ?, ?)').run('t', 'body', TS, TS, TS);
    db.prepare("INSERT INTO actions (id, text, owner, status, person_id, meeting_id, created_at, done_at) VALUES (7, 'a', 'them', 'done', 1, 1, ?, ?)").run(TS, TS);
    db.prepare("INSERT INTO agenda_items (id, person_id, text, status, created_at, resolved_at, resolved_meeting_id) VALUES (9, 1, 'g', 'done', ?, ?, 1)").run(TS, TS);
    return db;
  }

  it('preserves data, indexes, FKs and CHECK constraints', () => {
    const db = oldDb();
    expect(migrate(db)).toBe(latestVersion());
    expect(currentVersion(db)).toBe(latestVersion());
    expect(db.prepare('SELECT id, title, body_md, person_id, deleted_at FROM notes').all()).toEqual([
      { id: 5, title: 't', body_md: 'body', person_id: 1, deleted_at: TS },
    ]);
    expect(db.prepare('SELECT id, text, owner, status, person_id, meeting_id, done_at FROM actions').all()).toEqual([
      { id: 7, text: 'a', owner: 'them', status: 'done', person_id: 1, meeting_id: 1, done_at: TS },
    ]);
    expect(db.prepare('SELECT id, status, resolved_meeting_id FROM agenda_items').all()).toEqual([
      { id: 9, status: 'done', resolved_meeting_id: 1 },
    ]);
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('notes_person','actions_open','agenda_person')").all() as unknown as { name: string }[]).map((r) => r.name).sort();
    expect(idx).toEqual(['actions_open', 'agenda_person', 'notes_person']);
    for (const t of ['notes', 'actions', 'agenda_items']) {
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(t) as unknown as { sql: string }).sql).toContain('AUTOINCREMENT');
    }
    // CHECKs and FKs still enforced
    expect(() => db.prepare("INSERT INTO actions (text, owner, created_at) VALUES ('x', 'you', ?)").run(TS)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO agenda_items (person_id, text, status, created_at) VALUES (1, 'x', 'bogus', ?)").run(TS)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO notes (title, person_id, created_at, updated_at) VALUES ('x', 99, ?, ?)").run(TS, TS)).toThrow(/FOREIGN/);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('does not reuse the highest id after it is deleted', () => {
    const db = oldDb();
    migrate(db);
    db.prepare('DELETE FROM notes WHERE id = 5').run();
    const res = db.prepare("INSERT INTO notes (title, created_at, updated_at) VALUES ('n', ?, ?)").run(TS, TS);
    expect(Number(res.lastInsertRowid)).toBe(6);
    db.prepare('DELETE FROM actions').run();
    expect(Number(db.prepare("INSERT INTO actions (text, owner, created_at) VALUES ('x', 'me', ?)").run(TS).lastInsertRowid)).toBe(8);
  });
});
