import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, migrate } from './migrate.ts';
import { openDb } from './open.ts';

const TS = '2026-01-01T00:00:00.000Z';
const sql = (name: string): string => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');

/** A v0.1 database (migrations 1-4) with one row in every item table. */
function v01Db() {
  const db = openDb(':memory:');
  for (const [i, f] of ['001-init.sql', '002-devices.sql', '003-autoincrement-items.sql', '004-captures-autoincrement.sql'].entries()) {
    db.exec(sql(f));
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  db.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (1, 'Anna', ?, ?)").run(TS, TS);
  db.prepare("INSERT INTO notes (id, title, body_md, person_id, created_at, updated_at) VALUES (7, 't', 'body', 1, ?, ?)").run(TS, TS);
  db.prepare("INSERT INTO actions (id, text, owner, person_id, created_at) VALUES (8, 'do it', 'me', 1, ?)").run(TS);
  return db;
}

describe('migration 005 (projects, pins, recents)', () => {
  it('keeps every row and adds nullable project_id columns', () => {
    const db = v01Db();
    expect(migrate(db)).toBe(latestVersion());
    expect(currentVersion(db)).toBeGreaterThanOrEqual(5);
    expect(db.prepare('SELECT id, title, body_md, person_id, project_id FROM notes').all()).toEqual([
      { id: 7, title: 't', body_md: 'body', person_id: 1, project_id: null },
    ]);
    expect(db.prepare('SELECT id, text, person_id, project_id FROM actions').all()).toEqual([
      { id: 8, text: 'do it', person_id: 1, project_id: null },
    ]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM people').get()).toEqual({ n: 1 });
  });

  it('re-running is a no-op', () => {
    const db = v01Db();
    migrate(db);
    const v = currentVersion(db);
    expect(migrate(db)).toBe(v);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 });
  });

  it('enforces the CHECKs, the foreign keys and AUTOINCREMENT', () => {
    const db = v01Db();
    migrate(db);
    const ins = (status: string) =>
      db.prepare('INSERT INTO projects (title, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run('P', status, TS, TS);
    expect(() => ins('bogus')).toThrow(/CHECK/);
    for (const s of ['active', 'on_hold', 'done']) expect(() => ins(s)).not.toThrow();
    expect(() => db.prepare("INSERT INTO pins (kind, item_id, created_at) VALUES ('meeting', 1, ?)").run(TS)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO recents (kind, item_id, opened_at) VALUES ('action', 1, ?)").run(TS)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO recents (kind, item_id, opened_at) VALUES ('note', 1, ?)").run(TS)).not.toThrow();
    // foreign keys are on: a missing project / person is rejected
    expect(() => db.prepare('UPDATE notes SET project_id = 999 WHERE id = 7').run()).toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('INSERT INTO project_people (project_id, person_id, created_at) VALUES (1, 99, ?)').run(TS)).toThrow(/FOREIGN KEY/);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'projects'").get() as { sql: string }).sql).toContain('AUTOINCREMENT');
    // ids are not reused after the newest row is deleted
    db.prepare('DELETE FROM projects WHERE id = 3').run();
    expect(Number(ins('active').lastInsertRowid)).toBe(4);
  });

  it('creates the project indexes', () => {
    const db = v01Db();
    migrate(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['actions_project', 'notes_project']));
  });
});
