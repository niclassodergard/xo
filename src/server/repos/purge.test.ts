import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { migrate } from '../db/migrate.ts';
import { openDb } from '../db/open.ts';
import { createAction, getAction, softDeleteAction } from './actions.ts';
import { createAgendaItem, softDeleteAgendaItem } from './agenda.ts';
import { createNote, softDeleteNote } from './notes.ts';
import { createPerson } from './people.ts';
import { purgeDeleted } from './purge.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

const count = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as unknown as { n: number }).n;

describe('purgeDeleted', () => {
  it('removes soft-deleted rows older than 30 days, keeps newer, exact-boundary and live rows', () => {
    const p = createPerson(db, { name: 'Anna' }, NOW);
    const make = (deletedAgo: number | null) => {
      const n = createNote(db, { bodyMd: 'n', personId: p.id }, NOW);
      const a = createAction(db, { text: 'a', personId: p.id }, NOW);
      const g = createAgendaItem(db, { personId: p.id, text: 'g' }, NOW);
      if (deletedAgo !== null) {
        const t = ago(deletedAgo);
        softDeleteNote(db, n.id, t); softDeleteAction(db, a.id, t); softDeleteAgendaItem(db, g.id, t);
      }
      return { n, a, g };
    };
    make(30 * DAY + 1);      // purged
    make(30 * DAY);          // exactly at the cutoff: kept
    make(29 * DAY);          // kept
    const live = make(null); // never deleted: kept
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 1, agendaItems: 1, captures: 0 });
    expect([count('notes'), count('actions'), count('agenda_items')]).toEqual([3, 3, 3]);
    expect(getAction(db, live.a.id)).not.toBeNull();
    expect(count('people')).toBe(1);
    // idempotent
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 0, actions: 0, agendaItems: 0, captures: 0 });
  });

  it('honours a custom retention and works with referenced meetings and people', () => {
    const p = createPerson(db, { name: 'Anna' }, NOW);
    const m = db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (?, ?)').run(p.id, NOW.toISOString());
    const a = createAction(db, { text: 'f', personId: p.id, meetingId: Number(m.lastInsertRowid) }, NOW);
    softDeleteAction(db, a.id, ago(2 * DAY));
    expect(purgeDeleted(db, NOW, 3).actions).toBe(0);
    expect(purgeDeleted(db, NOW, 1).actions).toBe(1);
    expect(count('meetings')).toBe(1);
  });
});

function insertCapture(
  db: DatabaseSync,
  c: { text: string; status: string; filed?: unknown[]; summary?: string; updated?: Date },
): number {
  const ts = (c.updated ?? NOW).toISOString();
  const res = db
    .prepare(
      `INSERT INTO captures (text, source, status, draft, filed, summary, created_at, updated_at)
       VALUES (?, 'text', ?, ?, ?, ?, ?, ?)`,
    )
    .run(c.text, c.status, JSON.stringify({ kind: 'note', text: c.text }), JSON.stringify(c.filed ?? []), c.summary ?? '', ts, ts);
  return Number(res.lastInsertRowid);
}

function allTablesContain(db: DatabaseSync, needle: string): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[];
  return tables.some((t) => (db.prepare(`SELECT * FROM "${t.name}"`).all() as unknown[]).some((row) => JSON.stringify(row).includes(needle)));
}

describe('purgeDeleted and chat captures', () => {
  it('erases captured text from every table when its item is purged', () => {
    const secret = 'ZEBRA-QUARTZ-SECRET';
    const n = createNote(db, { bodyMd: secret }, NOW);
    const a = createAction(db, { text: secret }, NOW);
    const keep = createNote(db, { bodyMd: 'kept-note' }, NOW);
    const c1 = insertCapture(db, { text: secret, status: 'filed', filed: [{ kind: 'note', id: n.id }], summary: `Note: ${secret}` });
    const c2 = insertCapture(db, { text: `todo ${secret}`, status: 'filed', filed: [{ kind: 'action', id: a.id }] });
    const c3 = insertCapture(db, { text: 'kept capture', status: 'filed', filed: [{ kind: 'note', id: keep.id }] });
    // a ref of another kind with the same numeric id must not match
    const c4 = insertCapture(db, { text: 'other kind', status: 'filed', filed: [{ kind: 'agenda', id: n.id }, { kind: 'person', id: n.id }] });
    expect(allTablesContain(db, secret)).toBe(true);

    softDeleteNote(db, n.id, ago(31 * DAY));
    softDeleteAction(db, a.id, ago(31 * DAY));
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 1, agendaItems: 0, captures: 2 });
    expect(allTablesContain(db, secret)).toBe(false);
    const left = (db.prepare('SELECT id FROM captures ORDER BY id').all() as unknown as { id: number }[]).map((r) => r.id);
    expect(left).toEqual([c3, c4]);
    expect(left).not.toContain(c1);
    expect(left).not.toContain(c2);
  });

  it('keeps captures of items deleted within the window, and live pending/filed captures', () => {
    const n = createNote(db, { bodyMd: 'x' }, NOW);
    softDeleteNote(db, n.id, ago(5 * DAY));
    insertCapture(db, { text: 'recent', status: 'filed', filed: [{ kind: 'note', id: n.id }] });
    insertCapture(db, { text: 'pending', status: 'pending', updated: ago(90 * DAY) });
    expect(purgeDeleted(db, NOW)).toMatchObject({ notes: 0, captures: 0 });
    expect(count('captures')).toBe(2);
  });

  it('removes old undone/discarded captures but not recent ones', () => {
    insertCapture(db, { text: 'old undone', status: 'undone', updated: ago(31 * DAY) });
    insertCapture(db, { text: 'old discarded', status: 'discarded', updated: ago(40 * DAY) });
    insertCapture(db, { text: 'new undone', status: 'undone', updated: ago(29 * DAY) });
    insertCapture(db, { text: 'old filed, no refs', status: 'filed', updated: ago(90 * DAY) });
    expect(purgeDeleted(db, NOW).captures).toBe(2);
    expect(allTablesContain(db, 'old undone')).toBe(false);
    expect(allTablesContain(db, 'new undone')).toBe(true);
    expect(count('captures')).toBe(2);
  });

  it('ignores prototype-key and odd ref shapes instead of failing the purge', () => {
    const n = createNote(db, { bodyMd: 'x' }, NOW);
    softDeleteNote(db, n.id, ago(31 * DAY));
    const refs = [
      [{ kind: 'toString', id: 1 }], [{ kind: 'constructor', id: 1 }], [{ kind: '__proto__', id: 1 }],
      [{ kind: 'hasOwnProperty', id: n.id }], [null], [5], ['note'], [{ kind: 'note' }], [{ kind: 'note', id: '1' }],
    ];
    for (const r of refs) insertCapture(db, { text: 'odd', status: 'filed', filed: r });
    const hit = insertCapture(db, { text: 'real', status: 'filed', filed: [null, { kind: 'note', id: n.id }] });
    db.prepare("INSERT INTO captures (text, source, status, draft, filed, created_at, updated_at) VALUES ('obj', 'text', 'filed', '{}', '{\"kind\":\"note\"}', ?, ?)").run(NOW.toISOString(), NOW.toISOString());
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 0, agendaItems: 0, captures: 1 });
    expect(count('captures')).toBe(refs.length + 1);
    expect(db.prepare('SELECT id FROM captures WHERE id = ?').get(hit)).toBeUndefined();
  });

  it('tolerates malformed filed JSON', () => {
    const id = insertCapture(db, { text: 'weird', status: 'filed' });
    db.prepare('UPDATE captures SET filed = ? WHERE id = ?').run('{not json', id);
    expect(purgeDeleted(db, NOW).captures).toBe(0);
  });

  it('does not reuse ids of purged items', () => {
    createNote(db, { bodyMd: 'one' }, NOW);
    const top = createNote(db, { bodyMd: 'two' }, NOW);
    const act = createAction(db, { text: 'two' }, NOW);
    const ag = createAgendaItem(db, { personId: createPerson(db, { name: 'A' }, NOW).id, text: 'two' }, NOW);
    softDeleteNote(db, top.id, ago(31 * DAY));
    softDeleteAction(db, act.id, ago(31 * DAY));
    softDeleteAgendaItem(db, ag.id, ago(31 * DAY));
    purgeDeleted(db, NOW);
    expect(createNote(db, { bodyMd: 'three' }, NOW).id).toBe(top.id + 1);
    expect(createAction(db, { text: 'x' }, NOW).id).toBe(act.id + 1);
    expect(createAgendaItem(db, { personId: 1, text: 'x' }, NOW).id).toBe(ag.id + 1);
  });
});

describe('purgeDeleted on a real file', () => {
  it('leaves no trace of purged text in the database file or WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-purge-'));
    try {
      const path = join(dir, 'xo.db');
      const fdb = openDb(path);
      migrate(fdb);
      expect((fdb.prepare('PRAGMA secure_delete').get() as unknown as { secure_delete: number }).secure_delete).toBe(1);
      const secret = 'ZEBRA-QUARTZ-SECRET-ON-DISK';
      const n = createNote(fdb, { bodyMd: secret.repeat(5) }, NOW);
      insertCapture(fdb, { text: secret, status: 'filed', filed: [{ kind: 'note', id: n.id }] });
      softDeleteNote(fdb, n.id, ago(31 * DAY));
      purgeDeleted(fdb, NOW);
      const bytes = (f: string): string => (existsSync(f) ? readFileSync(f).toString('latin1') : '');
      expect(bytes(path)).not.toContain('ZEBRA-QUARTZ');
      expect(bytes(`${path}-wal`)).not.toContain('ZEBRA-QUARTZ');
      fdb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
