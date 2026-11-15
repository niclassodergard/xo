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
import { touchRecent, pin } from './nav.ts';
import { createPerson } from './people.ts';
import { createProject, getProject, linkPerson, softDeleteProject } from './projects.ts';
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
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 1, agendaItems: 1, captures: 0, projects: 0 });
    expect([count('notes'), count('actions'), count('agenda_items')]).toEqual([3, 3, 3]);
    expect(getAction(db, live.a.id)).not.toBeNull();
    expect(count('people')).toBe(1);
    // idempotent
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 0, actions: 0, agendaItems: 0, captures: 0, projects: 0 });
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
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 1, agendaItems: 0, captures: 2, projects: 0 });
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
    expect(purgeDeleted(db, NOW)).toMatchObject({ notes: 0, captures: 0, projects: 0 });
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
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 1, actions: 0, agendaItems: 0, captures: 1, projects: 0 });
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

describe('purgeDeleted and projects', () => {
  const TITLE = 'Zorbulon-Omega';
  const ALIAS = 'Quixotic-Alias';
  const DESC = 'Description-Marker-77';
  const rowOf = (id: number) => db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

  function setup() {
    const person = createPerson(db, { name: 'Anna' }, NOW);
    const proj = createProject(db, { title: TITLE, aliases: [ALIAS], descriptionMd: DESC }, NOW);
    linkPerson(db, proj.id, person.id, NOW);
    const action = createAction(db, { text: 'kept action', projectId: proj.id }, NOW);
    const note = createNote(db, { title: 'kept note', bodyMd: 'x', projectId: proj.id }, NOW);
    const q = JSON.stringify({
      type: 'ambiguous_project', name: 'zorb',
      candidates: [{ key: '1', projectId: proj.id, title: TITLE }], options: [],
    });
    const draft = JSON.stringify({ kind: 'note', text: 'about zorb', personId: null, personName: null, projectId: null, projectName: 'zorb', owner: 'me', projectPending: true, projectCandidates: [proj.id], projectSuggested: false });
    db.prepare("INSERT INTO captures (text, source, status, draft, question, filed, summary, created_at, updated_at) VALUES ('about zorb', 'text', 'pending', ?, ?, '[]', '', ?, ?)")
      .run(draft, q, NOW.toISOString(), NOW.toISOString());
    return { person, proj, action, note };
  }

  it('erases an old soft-deleted project everywhere and keeps its actions and notes', () => {
    const { proj, action, note } = setup();
    for (const needle of [TITLE, ALIAS, DESC]) expect(allTablesContain(db, needle)).toBe(true);
    softDeleteProject(db, proj.id, ago(31 * DAY));
    expect(allTablesContain(db, TITLE)).toBe(true); // soft delete keeps the row until the purge
    expect(purgeDeleted(db, NOW)).toEqual({ notes: 0, actions: 0, agendaItems: 0, captures: 0, projects: 1 });
    for (const needle of [TITLE, ALIAS, DESC]) expect(allTablesContain(db, needle)).toBe(false);
    expect(rowOf(proj.id)).toBeUndefined();
    expect(getAction(db, action.id)).toMatchObject({ projectId: null });
    expect(db.prepare('SELECT project_id FROM notes WHERE id = ?').get(note.id)).toMatchObject({ project_id: null });
    expect(count('project_people')).toBe(0);
    expect(purgeDeleted(db, NOW).projects).toBe(0);
  });

  it('keeps projects deleted inside the window and live ones', () => {
    const { proj } = setup();
    const recent = createProject(db, { title: 'Recent' }, NOW);
    softDeleteProject(db, recent.id, ago(29 * DAY));
    expect(purgeDeleted(db, NOW).projects).toBe(0);
    expect(rowOf(recent.id)).toBeDefined();
    expect(getProject(db, proj.id)).not.toBeNull();
  });

  it('re-runs the capture scrub as a safety net', () => {
    const { proj } = setup();
    softDeleteProject(db, proj.id, ago(31 * DAY));
    // simulate a capture that missed the soft-delete scrub
    const q = JSON.stringify({ type: 'ambiguous_project', name: 'zorb', candidates: [{ key: '1', projectId: proj.id, title: TITLE }], options: [] });
    db.prepare("UPDATE captures SET question = ?").run(q);
    expect(allTablesContain(db, TITLE)).toBe(true);
    purgeDeleted(db, NOW);
    expect(allTablesContain(db, TITLE)).toBe(false);
  });

  it('skips a bad capture row instead of failing', () => {
    const { proj } = setup();
    db.prepare("INSERT INTO captures (text, source, status, draft, question, filed, summary, created_at, updated_at) VALUES ('bad', 'text', 'pending', 'not json', '{oops', 'zzz', '', ?, ?)")
      .run(NOW.toISOString(), NOW.toISOString());
    softDeleteProject(db, proj.id, ago(31 * DAY));
    expect(purgeDeleted(db, NOW).projects).toBe(1);
    expect(allTablesContain(db, TITLE)).toBe(false);
  });

  it('removes pins and recents of vanished items, and recents of purged notes', () => {
    const person = createPerson(db, { name: 'Anna' }, NOW);
    const live = createNote(db, { title: 'live', bodyMd: 'x' }, NOW);
    const dead = createNote(db, { title: 'dead', bodyMd: 'x' }, NOW);
    const young = createNote(db, { title: 'young', bodyMd: 'x' }, NOW);
    for (const n of [live, dead, young]) touchRecent(db, 'note', n.id, NOW);
    pin(db, 'person', person.id, NOW);
    softDeleteNote(db, dead.id, ago(31 * DAY));
    softDeleteNote(db, young.id, ago(1 * DAY));
    // orphans that should never exist, planted directly
    db.prepare("INSERT INTO pins (kind, item_id, created_at) VALUES ('project', 999, ?)").run(NOW.toISOString());
    db.prepare("INSERT INTO recents (kind, item_id, opened_at) VALUES ('meeting', 999, ?)").run(NOW.toISOString());
    const result = purgeDeleted(db, NOW);
    expect(result).toEqual({ notes: 1, actions: 0, agendaItems: 0, captures: 0, projects: 0 });
    expect(db.prepare('SELECT kind, item_id FROM recents ORDER BY item_id').all()).toEqual([
      { kind: 'note', item_id: live.id }, { kind: 'note', item_id: young.id },
    ]);
    expect(db.prepare('SELECT kind, item_id FROM pins').all()).toEqual([{ kind: 'person', item_id: person.id }]);
  });
});

describe('purgeDeleted: answered captures (question answering)', () => {
  const answered = (sources: string | null, answer: string | null = 'ANSWER-TEXT'): number =>
    Number(db.prepare(
      `INSERT INTO captures (text, source, status, draft, answer, sources, created_at, updated_at)
       VALUES ('/ask q', 'text', 'answered', '{}', ?, ?, ?, ?)`,
    ).run(answer, sources, NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  const ids = (): number[] => (db.prepare('SELECT id FROM captures ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  const sent = (...refs: { kind: string; id: number }[]): string => JSON.stringify({ sent: refs, cited: [] });

  it('erases an answer when any sent note, action, agenda item or project is purged; keeps it while it is only soft-deleted', () => {
    const p = createPerson(db, { name: 'Anna' }, NOW);
    const n = createNote(db, { bodyMd: 'n' }, NOW);
    const a = createAction(db, { text: 'a' }, NOW);
    const g = createAgendaItem(db, { personId: p.id, text: 'g' }, NOW);
    const j = createProject(db, { title: 'J' }, NOW);
    const live = createNote(db, { bodyMd: 'live' }, NOW);
    const byNote = answered(sent({ kind: 'note', id: live.id }, { kind: 'note', id: n.id }));
    const byAction = answered(sent({ kind: 'action', id: a.id }));
    const byAgenda = answered(sent({ kind: 'agenda', id: g.id }, { kind: 'person', id: p.id }));
    const byProject = answered(sent({ kind: 'project', id: j.id }));
    const untouched = answered(sent({ kind: 'note', id: live.id }, { kind: 'person', id: p.id }, { kind: 'meeting', id: 1 }));
    const noSources = answered(sent());

    // Soft-deleted but not yet due: everything stays (the read path redacts it).
    softDeleteNote(db, n.id, ago(5 * DAY)); softDeleteAction(db, a.id, ago(5 * DAY));
    softDeleteAgendaItem(db, g.id, ago(5 * DAY)); softDeleteProject(db, j.id, ago(5 * DAY));
    expect(purgeDeleted(db, NOW).captures).toBe(0);
    expect(ids()).toHaveLength(6);

    // Due: every answer that used a purged row goes, and nothing else.
    const later = new Date(NOW.getTime() + 40 * DAY);
    expect(purgeDeleted(db, later).captures).toBe(4);
    expect(ids()).toEqual([untouched, noSources]);
    expect([byNote, byAction, byAgenda, byProject].some((id) => ids().includes(id))).toBe(false);
  });

  it('a project purged on its own erases the answers that used it, and no answer text survives anywhere', () => {
    const j = createProject(db, { title: 'Secret project' }, NOW);
    answered(sent({ kind: 'project', id: j.id }), 'ANSWER-ABOUT-SECRET');
    expect(JSON.stringify(db.prepare('SELECT * FROM captures').all())).toContain('ANSWER-ABOUT-SECRET');
    softDeleteProject(db, j.id, ago(31 * DAY));
    purgeDeleted(db, NOW);
    expect(count('captures')).toBe(0);
    expect(JSON.stringify(db.prepare('SELECT * FROM captures').all())).not.toContain('ANSWER-ABOUT-SECRET');
  });

  it('an answer that used a row which no longer exists is erased; a damaged or missing source list is erased (fail closed)', () => {
    const live = createNote(db, { bodyMd: 'live' }, NOW);
    answered(sent({ kind: 'note', id: live.id }, { kind: 'note', id: 424242 })); // row is gone
    answered('not json');
    answered(null);
    answered(JSON.stringify({ cited: [] }));
    const keep = answered(sent({ kind: 'note', id: live.id }));
    purgeDeleted(db, NOW);
    expect(ids()).toEqual([keep]);
  });

  it('one damaged entry anywhere in the source lists erases the answer (fail closed); the purge never throws on them', () => {
    const live = createNote(db, { bodyMd: 'live' }, NOW);
    const ok = { kind: 'note', id: live.id };
    const keep = answered(JSON.stringify({ sent: [ok], cited: [ok] }));
    const bad: unknown[] = [null, 7, 'x', { kind: 'toString', id: 1 }, { kind: 'note' }, { kind: 'note', id: 1.5 }];
    for (const entry of bad) answered(JSON.stringify({ sent: [ok, entry], cited: [] }));
    answered(JSON.stringify({ sent: [ok], cited: [null] }));
    expect(() => purgeDeleted(db, NOW)).not.toThrow();
    expect(ids()).toEqual([keep]);
    const gone = answered('not json');
    purgeDeleted(db, NOW);
    expect(ids()).toEqual([keep]);
    expect(answered(sent())).toBeGreaterThan(gone); // purged ids are not reused
  });
});
