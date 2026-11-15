import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { currentVersion, latestVersion, migrate } from './migrate.ts';
import { openDb } from './open.ts';

const TS = '2026-01-01T00:00:00.000Z';
const sql = (name: string): string => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8');

function oldDb() {
  const db = openDb(':memory:');
  for (const [i, f] of ['001-init.sql', '002-devices.sql', '003-autoincrement-items.sql'].entries()) {
    db.exec(sql(f));
    db.exec(`PRAGMA user_version = ${i + 1}`);
  }
  db.prepare(
    `INSERT INTO captures (id, text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at)
     VALUES (12, 'hello', 'voice', 'filed', '{"k":1}', NULL, '[{"kind":"note","id":3}]', 'Note: hello', 'llm', ?, ?)`,
  ).run(TS, TS);
  return db;
}

describe('migration 004 (AUTOINCREMENT for captures)', () => {
  it('preserves data and CHECK constraints and uses AUTOINCREMENT', () => {
    const db = oldDb();
    expect(migrate(db)).toBe(latestVersion());
    expect(currentVersion(db)).toBeGreaterThanOrEqual(4);
    expect(db.prepare('SELECT * FROM captures').all()).toEqual([
      { id: 12, text: 'hello', source: 'voice', status: 'filed', draft: '{"k":1}', question: null,
        filed: '[{"kind":"note","id":3}]', summary: 'Note: hello', classified_by: 'llm', created_at: TS, updated_at: TS },
    ]);
    expect((db.prepare("SELECT sql FROM sqlite_master WHERE name = 'captures'").get() as { sql: string }).sql).toContain('AUTOINCREMENT');
    const ins = (status: string, source = 'text', by: string | null = null) =>
      db.prepare("INSERT INTO captures (text, source, status, draft, classified_by, created_at, updated_at) VALUES ('x', ?, ?, '{}', ?, ?, ?)").run(source, status, by, TS, TS);
    expect(() => ins('bogus')).toThrow(/CHECK/);
    expect(() => ins('pending', 'fax')).toThrow(/CHECK/);
    expect(() => ins('pending', 'text', 'robot')).toThrow(/CHECK/);
  });

  it('does not reuse the highest id after it is deleted', () => {
    const db = oldDb();
    migrate(db);
    db.prepare('DELETE FROM captures WHERE id = 12').run();
    const res = db.prepare("INSERT INTO captures (text, source, status, draft, created_at, updated_at) VALUES ('x', 'text', 'pending', '{}', ?, ?)").run(TS, TS);
    expect(Number(res.lastInsertRowid)).toBe(13);
  });
});
