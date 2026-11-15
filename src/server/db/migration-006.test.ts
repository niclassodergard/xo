import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeDeps } from '../../../test/helpers.ts';
import { createCaptureService } from '../capture/service.ts';
import { currentVersion, latestVersion, migrate } from './migrate.ts';
import { openDb } from './open.ts';

const TS = '2026-01-01T00:00:00.000Z';
const sql = (name: string): string => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');
const FILES = ['001-init.sql', '002-devices.sql', '003-autoincrement-items.sql', '004-captures-autoincrement.sql', '005-projects.sql'];

/** A v0.1 database that has had migration 005: migrations 1-5 only. */
function v02Db(path = ':memory:') {
  const db = openDb(path);
  for (const [i, f] of FILES.entries()) {
    db.exec(sql(f));
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  return db;
}
const insert = (db: ReturnType<typeof openDb>, text: string, status = 'pending', extra: Record<string, string | null> = {}) =>
  db.prepare(
    `INSERT INTO captures (text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at)
     VALUES (?, 'text', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(text, status, extra['draft'] ?? '{}', extra['question'] ?? null, extra['filed'] ?? '[]', extra['summary'] ?? '', extra['by'] ?? null, TS, TS);
const seq = (db: ReturnType<typeof openDb>): number | undefined =>
  (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'captures'").get() as { seq: number } | undefined)?.seq;

describe('migration 006 (question answering)', () => {
  it('keeps every capture, adds answer and sources, and accepts the new statuses', () => {
    const db = v02Db();
    insert(db, 'first', 'filed', { filed: '[{"kind":"note","id":3}]', summary: 'Note: first', by: 'llm' });
    insert(db, 'second', 'pending', { question: '{"type":"kind","options":[]}' });
    expect(migrate(db)).toBe(latestVersion());
    expect(currentVersion(db)).toBeGreaterThanOrEqual(6);
    expect(db.prepare('SELECT id, text, status, filed, summary, classified_by, question, answer, sources FROM captures ORDER BY id').all()).toEqual([
      { id: 1, text: 'first', status: 'filed', filed: '[{"kind":"note","id":3}]', summary: 'Note: first', classified_by: 'llm', question: null, answer: null, sources: null },
      { id: 2, text: 'second', status: 'pending', filed: '[]', summary: '', classified_by: null, question: '{"type":"kind","options":[]}', answer: null, sources: null },
    ]);
    const ins = (status: string, source = 'text', by: string | null = null) =>
      db.prepare("INSERT INTO captures (text, source, status, draft, classified_by, created_at, updated_at) VALUES ('x', ?, ?, '{}', ?, ?, ?)").run(source, status, by, TS, TS);
    for (const ok of ['pending', 'filed', 'undone', 'discarded', 'asked', 'answered']) expect(() => ins(ok)).not.toThrow();
    expect(() => ins('bogus')).toThrow(/CHECK/);
    expect(() => ins('pending', 'fax')).toThrow(/CHECK/);
    expect(() => ins('pending', 'text', 'robot')).toThrow(/CHECK/);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql).toContain('AUTOINCREMENT');
  });

  it('carries the sqlite_sequence high-water mark over: purged ids are never reused', () => {
    const db = v02Db();
    for (let i = 1; i <= 5; i++) insert(db, `c${i}`);
    db.prepare('DELETE FROM captures WHERE id IN (4, 5)').run(); // "purged": the highest ids are gone
    expect(seq(db)).toBe(5);
    migrate(db);
    expect(seq(db)).toBe(5);
    const next = db.prepare("INSERT INTO captures (text, source, status, draft, created_at, updated_at) VALUES ('n', 'text', 'pending', '{}', ?, ?)").run(TS, TS);
    expect(Number(next.lastInsertRowid)).toBe(6); // not 4: a stale cursor or ref cannot point at a new capture
  });

  it('carries the mark over when every capture was purged, and when none was ever made', () => {
    const emptied = v02Db();
    for (let i = 1; i <= 3; i++) insert(emptied, `c${i}`);
    emptied.prepare('DELETE FROM captures').run();
    migrate(emptied);
    expect(Number(insert(emptied, 'again').lastInsertRowid)).toBe(4);

    const fresh = v02Db();
    migrate(fresh);
    expect(Number(insert(fresh, 'first').lastInsertRowid)).toBe(1);
    expect(seq(fresh)).toBe(1);
  });

  it('upgrades a copy of a real v0.1 + 005 database file: data intact, chat history readable, ids not reused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-mig006-'));
    try {
      const src = join(dir, 'xo.db');
      const copy = join(dir, 'copy.db');
      const db = v02Db(src);
      db.prepare("INSERT INTO people (id, name, created_at, updated_at) VALUES (1, 'Anna', ?, ?)").run(TS, TS);
      db.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (1, 'Apollo', ?, ?)").run(TS, TS);
      db.prepare("INSERT INTO notes (id, title, body_md, person_id, project_id, created_at, updated_at) VALUES (7, 't', 'body', 1, 1, ?, ?)").run(TS, TS);
      db.prepare("INSERT INTO actions (id, text, owner, person_id, created_at) VALUES (8, 'do it', 'me', 1, ?)").run(TS);
      db.prepare("INSERT INTO pins (kind, item_id, created_at) VALUES ('person', 1, ?)").run(TS);
      insert(db, 'remember the board', 'filed', { filed: '[{"kind":"note","id":7}]', summary: 'Note: remember the board', by: 'llm' });
      insert(db, 'who is this', 'pending', {
        draft: '{"kind":null,"text":"who is this","personId":null,"personName":null,"projectId":null,"projectName":null,"owner":"me"}',
        question: '{"type":"kind","options":[{"key":"n","label":"Note"},{"key":"d","label":"Discard"}]}',
      });
      insert(db, 'purged later', 'discarded');
      db.prepare('DELETE FROM captures WHERE id = 3').run(); // the newest capture was purged: seq 3, max id 2
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
      copyFileSync(src, copy); // the real file stays untouched; the upgrade runs on the copy

      const up = openDb(copy);
      expect(migrate(up)).toBe(latestVersion());
      expect(up.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect((up.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check).toBe('ok');
      expect(up.prepare('SELECT id, title, project_id FROM notes').all()).toEqual([{ id: 7, title: 't', project_id: 1 }]);
      expect(up.prepare('SELECT COUNT(*) AS n FROM pins').get()).toEqual({ n: 1 });

      // The upgraded chat history is served by the real service, untouched by the new columns.
      const deps = makeDeps({ db: up });
      const list = createCaptureService(deps).list({ limit: 10 });
      expect(list.map((c) => [c.id, c.status, c.answer])).toEqual([[1, 'filed', null], [2, 'pending', null]]);
      expect(list[1]!.question).toMatchObject({ type: 'kind' });

      expect(Number(insert(up, 'new').lastInsertRowid)).toBe(4); // 3 was purged before the upgrade and is not reused
      up.close();
      const original = openDb(src);
      expect(currentVersion(original)).toBe(5); // the source file was not upgraded
      original.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-running is a no-op', () => {
    const db = v02Db();
    insert(db, 'a');
    migrate(db);
    const v = currentVersion(db);
    expect(migrate(db)).toBe(v);
    expect(db.prepare('SELECT COUNT(*) AS n FROM captures').get()).toEqual({ n: 1 });
  });
});
