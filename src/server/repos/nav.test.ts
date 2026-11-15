import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { LIMITS } from '../../shared/api.ts';
import { getNav, pin, touchRecent, unpin } from './nav.ts';
import { createNote, softDeleteNote } from './notes.ts';
import { createPerson, updatePerson } from './people.ts';
import { createProject, softDeleteProject } from './projects.ts';

const T = new Date('2026-01-01T10:00:00.000Z');
const at = (min: number): Date => new Date(T.getTime() + min * 60_000);
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

const archivePerson = (id: number, now: Date) => updatePerson(db, id, { archived: true }, now);
const meeting = (personId: number, started = '2026-02-03T09:00:00.000Z'): number =>
  Number(db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (?, ?)').run(personId, started).lastInsertRowid);

describe('pins', () => {
  it('pin and unpin are idempotent and keep the first pin time', () => {
    const p = createPerson(db, { name: 'Anna' }, T);
    expect(pin(db, 'person', p.id, at(0))).toBe('ok');
    expect(pin(db, 'person', p.id, at(5))).toBe('ok');
    expect(db.prepare('SELECT created_at FROM pins').all()).toEqual([{ created_at: at(0).toISOString() }]);
    unpin(db, 'person', p.id);
    unpin(db, 'person', p.id);
    expect(getNav(db).pinned).toEqual([]);
  });

  it('reports missing and soft-deleted items, accepts archived people', () => {
    const proj = createProject(db, { title: 'Apollo' }, T);
    const p = createPerson(db, { name: 'Anna' }, T);
    expect(pin(db, 'person', 999, T)).toBe('missing');
    expect(pin(db, 'project', 999, T)).toBe('missing');
    softDeleteProject(db, proj.id, T);
    expect(pin(db, 'project', proj.id, T)).toBe('missing');
    archivePerson(p.id, T);
    expect(pin(db, 'person', p.id, T)).toBe('ok');
    expect(getNav(db).pinned).toEqual([{ kind: 'person', id: p.id, title: 'Anna', archived: true }]);
  });

  it('allows 50 pins and refuses the 51st, but re-pinning at the limit is fine', () => {
    const ids = Array.from({ length: LIMITS.pins + 1 }, (_, i) => createPerson(db, { name: `P${i}` }, T).id);
    for (const id of ids.slice(0, LIMITS.pins)) expect(pin(db, 'person', id, T)).toBe('ok');
    expect(pin(db, 'person', ids[LIMITS.pins]!, T)).toBe('too_many');
    expect(pin(db, 'person', ids[0]!, T)).toBe('ok');
    expect(getNav(db).pinned).toHaveLength(LIMITS.pins);
  });

  it('lists pins oldest first and hides deleted projects', () => {
    const a = createProject(db, { title: 'B-proj' }, T);
    const b = createPerson(db, { name: 'Anna' }, T);
    pin(db, 'project', a.id, at(1));
    pin(db, 'person', b.id, at(0));
    expect(getNav(db).pinned.map((i) => i.title)).toEqual(['Anna', 'B-proj']);
    softDeleteProject(db, a.id, T);
    expect(getNav(db).pinned.map((i) => i.title)).toEqual(['Anna']);
  });
});

describe('recents', () => {
  it('titles per kind, meeting format and archived flag', () => {
    const anna = createPerson(db, { name: 'Anna Berg' }, T);
    const bo = createPerson(db, { name: 'Bo' }, T);
    const m = meeting(anna.id);
    const note = createNote(db, { title: 'Plan', bodyMd: 'x' }, T);
    const proj = createProject(db, { title: 'Åre-resa' }, T);
    archivePerson(anna.id, T);
    for (const [i, [kind, id]] of ([['person', bo.id], ['meeting', m], ['note', note.id], ['project', proj.id], ['person', anna.id]] as const).entries()) {
      expect(touchRecent(db, kind, id, at(i))).toBe(true);
    }
    expect(getNav(db).recents).toEqual([
      { kind: 'person', id: anna.id, title: 'Anna Berg', archived: true },
      { kind: 'project', id: proj.id, title: 'Åre-resa', archived: false },
      { kind: 'note', id: note.id, title: 'Plan', archived: false },
      { kind: 'meeting', id: m, title: '1-1 Anna Berg 2026-02-03', archived: true },
      { kind: 'person', id: bo.id, title: 'Bo', archived: false },
    ]);
  });

  it('re-opening moves to the top, also with identical timestamps', () => {
    const a = createPerson(db, { name: 'A' }, T);
    const b = createPerson(db, { name: 'B' }, T);
    touchRecent(db, 'person', a.id, T);
    touchRecent(db, 'person', b.id, T);
    touchRecent(db, 'person', a.id, T);
    expect(getNav(db).recents.map((r) => r.title)).toEqual(['A', 'B']);
  });

  it('returns 15, stores 50', () => {
    const ids = Array.from({ length: 60 }, (_, i) => createPerson(db, { name: `P${i}` }, T).id);
    ids.forEach((id, i) => touchRecent(db, 'person', id, at(i)));
    const nav = getNav(db);
    expect(nav.recents).toHaveLength(LIMITS.recents);
    expect(nav.recents[0]?.id).toBe(ids[59]);
    const stored = db.prepare('SELECT item_id FROM recents ORDER BY opened_at').all() as unknown as { item_id: number }[];
    expect(stored).toHaveLength(LIMITS.recentsStored);
    expect(stored[0]?.item_id).toBe(ids[10]);
  });

  it('rejects missing and soft-deleted items; hides ones deleted later', () => {
    const note = createNote(db, { title: 'N', bodyMd: 'x' }, T);
    const proj = createProject(db, { title: 'P' }, T);
    expect(touchRecent(db, 'meeting', 999, T)).toBe(false);
    expect(touchRecent(db, 'person', 999, T)).toBe(false);
    expect(touchRecent(db, 'note', note.id, T)).toBe(true);
    softDeleteNote(db, note.id, T);
    expect(getNav(db).recents).toEqual([]);
    expect(touchRecent(db, 'note', note.id, T)).toBe(false);
    softDeleteProject(db, proj.id, T);
    expect(touchRecent(db, 'project', proj.id, T)).toBe(false);
  });
});
