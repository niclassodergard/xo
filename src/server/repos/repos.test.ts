import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { createAction, getAction, listActions, softDeleteAction, updateAction } from './actions.ts';
import { createAgendaItem, getAgendaItem, softDeleteAgendaItem, updateAgendaItem } from './agenda.ts';
import { createNote, getNote, listNotes, softDeleteNote, updateNote } from './notes.ts';
import { createPerson, getPerson, getPersonDetail, listPeople, updatePerson } from './people.ts';

const T0 = new Date('2026-01-01T10:00:00.000Z');
const T1 = new Date('2026-01-02T10:00:00.000Z');
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

describe('people repo', () => {
  it('creates, normalizes aliases, lists, updates and archives', () => {
    const p = createPerson(db, { name: ' Anna ', aliases: [' Ann ', 'ann', '', 'A'] }, T0);
    expect(p).toMatchObject({ name: 'Anna', aliases: ['Ann', 'A'], notesMd: '', archivedAt: null, createdAt: T0.toISOString() });
    createPerson(db, { name: 'bob' }, T0);
    expect(listPeople(db).map((x) => x.name)).toEqual(['Anna', 'bob']);

    const u = updatePerson(db, p.id, { notesMd: 'hi', archived: true }, T1)!;
    expect(u.notesMd).toBe('hi');
    expect(u.archivedAt).toBe(T1.toISOString());
    expect(u.updatedAt).toBe(T1.toISOString());
    expect(listPeople(db).map((x) => x.name)).toEqual(['bob']);
    expect(listPeople(db, { includeArchived: true })).toHaveLength(2);
    expect(updatePerson(db, p.id, { archived: false }, T1)!.archivedAt).toBeNull();
  });

  it('sorts Swedish names Unicode-aware', () => {
    for (const n of ['Östen', 'zeb', 'Åsa', 'Ann', 'Älva', 'anna', 'Bo']) createPerson(db, { name: n }, T0);
    expect(listPeople(db).map((x) => x.name)).toEqual(['Ann', 'anna', 'Bo', 'zeb', 'Åsa', 'Älva', 'Östen']);
  });

  it('returns null for unknown ids', () => {
    expect(getPerson(db, 99)).toBeNull();
    expect(updatePerson(db, 99, { name: 'x' }, T0)).toBeNull();
    expect(getPersonDetail(db, 99)).toBeNull();
  });

  it('detail excludes soft-deleted and resolved items', () => {
    const p = createPerson(db, { name: 'Anna' }, T0);
    const a1 = createAgendaItem(db, { personId: p.id, text: 'one' }, T0);
    const a2 = createAgendaItem(db, { personId: p.id, text: 'two' }, T0);
    createAgendaItem(db, { personId: p.id, text: 'three' }, T0);
    softDeleteAgendaItem(db, a1.id, T1);
    updateAgendaItem(db, a2.id, { status: 'done' }, T1);
    const n = createNote(db, { bodyMd: 'note', personId: p.id }, T0);
    const n2 = createNote(db, { bodyMd: 'gone', personId: p.id }, T0);
    softDeleteNote(db, n2.id, T1);
    const act = createAction(db, { text: 'act', personId: p.id }, T0);
    const act2 = createAction(db, { text: 'done', personId: p.id }, T0);
    updateAction(db, act2.id, { status: 'done' }, T1);
    const d = getPersonDetail(db, p.id)!;
    expect(d.openAgenda.map((i) => i.text)).toEqual(['three']);
    expect(d.notes.map((x) => x.id)).toEqual([n.id]);
    expect(d.openActions.map((x) => x.id)).toEqual([act.id]);
    expect(d.activeMeetingId).toBeNull();
  });
});

describe('notes repo', () => {
  it('derives the title from the first line (max 80 chars) and orders newest first', () => {
    const a = createNote(db, { bodyMd: `\n  First line\nsecond` }, T0);
    expect(a.title).toBe('First line');
    const long = createNote(db, { bodyMd: 'x'.repeat(200) }, T1);
    expect(long.title).toHaveLength(80);
    expect(createNote(db, { bodyMd: '   ' }, T0).title).toBe('Untitled');
    const last = createNote(db, { title: 'Given', bodyMd: 'b' }, T0);
    expect(last.title).toBe('Given');
    // newest first = highest id first (ids are the cursor for `before`)
    expect(listNotes(db).map((n) => n.id)).toEqual([last.id, last.id - 1, long.id, a.id]);
  });

  it('filters by person, updates, soft-deletes', () => {
    const p = createPerson(db, { name: 'Anna' }, T0);
    const n = createNote(db, { bodyMd: 'a', personId: p.id }, T0);
    createNote(db, { bodyMd: 'b' }, T0);
    expect(listNotes(db, { personId: p.id }).map((x) => x.id)).toEqual([n.id]);
    const u = updateNote(db, n.id, { bodyMd: 'changed', personId: null }, T1)!;
    expect(u).toMatchObject({ bodyMd: 'changed', personId: null, title: 'a', updatedAt: T1.toISOString() });
    expect(softDeleteNote(db, n.id, T1)).toBe(true);
    expect(softDeleteNote(db, n.id, T1)).toBe(false);
    expect(getNote(db, n.id)).toBeNull();
    expect(updateNote(db, n.id, { bodyMd: 'x' }, T1)).toBeNull();
    expect(listNotes(db)).toHaveLength(1);
  });
});

describe('actions repo', () => {
  it('defaults owner to me, toggles done and sets/clears doneAt', () => {
    const a = createAction(db, { text: 'call' }, T0);
    expect(a).toMatchObject({ owner: 'me', status: 'open', doneAt: null });
    const done = updateAction(db, a.id, { status: 'done' }, T1)!;
    expect(done.doneAt).toBe(T1.toISOString());
    // a second "done" keeps the original timestamp
    expect(updateAction(db, a.id, { status: 'done' }, new Date('2026-02-01T00:00:00Z'))!.doneAt).toBe(T1.toISOString());
    const reopened = updateAction(db, a.id, { status: 'open' }, T1)!;
    expect(reopened).toMatchObject({ status: 'open', doneAt: null });
  });

  it('filters and soft-deletes', () => {
    const p = createPerson(db, { name: 'Anna' }, T0);
    const mine = createAction(db, { text: 'm', personId: p.id }, T0);
    const theirs = createAction(db, { text: 't', owner: 'them' }, T0);
    const done = createAction(db, { text: 'd' }, T0);
    updateAction(db, done.id, { status: 'done' }, T1);
    expect(listActions(db).map((x) => x.id).sort()).toEqual([mine.id, theirs.id]);
    expect(listActions(db, { status: 'done' }).map((x) => x.id)).toEqual([done.id]);
    expect(listActions(db, { status: 'all' })).toHaveLength(3);
    expect(listActions(db, { owner: 'them' }).map((x) => x.id)).toEqual([theirs.id]);
    expect(listActions(db, { personId: p.id }).map((x) => x.id)).toEqual([mine.id]);
    expect(softDeleteAction(db, mine.id, T1)).toBe(true);
    expect(getAction(db, mine.id)).toBeNull();
    expect(listActions(db, { status: 'all' })).toHaveLength(2);
    expect(updateAction(db, mine.id, { text: 'x' }, T1)).toBeNull();
  });
});

describe('agenda repo', () => {
  it('records and clears resolution', () => {
    const p = createPerson(db, { name: 'Anna' }, T0);
    const m = db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (?, ?)').run(p.id, T0.toISOString());
    const meetingId = Number(m.lastInsertRowid);
    const i = createAgendaItem(db, { personId: p.id, text: 'topic' }, T0);
    expect(i).toMatchObject({ status: 'open', resolvedAt: null, resolvedMeetingId: null });
    const done = updateAgendaItem(db, i.id, { status: 'done', meetingId }, T1)!;
    expect(done).toMatchObject({ status: 'done', resolvedAt: T1.toISOString(), resolvedMeetingId: meetingId });
    const open = updateAgendaItem(db, i.id, { status: 'open' }, T1)!;
    expect(open).toMatchObject({ status: 'open', resolvedAt: null, resolvedMeetingId: null });
    expect(updateAgendaItem(db, i.id, { text: 'renamed' }, T1)!.text).toBe('renamed');
    expect(softDeleteAgendaItem(db, i.id, T1)).toBe(true);
    expect(getAgendaItem(db, i.id)).toBeNull();
    expect(updateAgendaItem(db, i.id, { text: 'x' }, T1)).toBeNull();
    expect(softDeleteAgendaItem(db, i.id, T1)).toBe(false);
  });
});
