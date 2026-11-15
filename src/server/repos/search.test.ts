import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { createAction, softDeleteAction } from './actions.ts';
import { createAgendaItem, softDeleteAgendaItem } from './agenda.ts';
import { startMeeting, updateMeetingNotes } from './meetings.ts';
import { createNote, softDeleteNote } from './notes.ts';
import { createPerson, updatePerson } from './people.ts';
import { fold, search } from './search.ts';

const T = new Date('2026-01-01T10:00:00.000Z');
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

describe('search', () => {
  it('finds every type and excludes soft-deleted rows', () => {
    const p = createPerson(db, { name: 'Anna Berg', aliases: ['Annie'] }, T);
    const n = createNote(db, { bodyMd: 'budget planning for Q3' }, T);
    const a = createAction(db, { text: 'send budget', personId: p.id }, T);
    const g = createAgendaItem(db, { personId: p.id, text: 'budget review' }, T);
    updateMeetingNotes(db, startMeeting(db, p.id, T)!.meeting.id, 'talked budget');
    const kinds = search(db, 'budget').map((r) => r.kind).sort();
    expect(kinds).toEqual(['action', 'agenda', 'meeting', 'note']);
    expect(search(db, 'annie')).toMatchObject([{ kind: 'person', id: p.id, snippet: 'Annie' }]);
    expect(search(db, 'berg')[0]).toMatchObject({ kind: 'person', title: 'Anna Berg' });

    softDeleteNote(db, n.id, T);
    softDeleteAction(db, a.id, T);
    softDeleteAgendaItem(db, g.id, T);
    expect(search(db, 'budget').map((r) => r.kind)).toEqual(['meeting']);
  });

  it('builds snippets around the match and fills personId', () => {
    const p = createPerson(db, { name: 'Bo' }, T);
    createAgendaItem(db, { personId: p.id, text: `${'x '.repeat(60)}needle${' y'.repeat(60)}` }, T);
    const [r] = search(db, 'needle');
    expect(r!.personId).toBe(p.id);
    expect(r!.snippet).toContain('needle');
    expect(r!.snippet.length).toBeLessThan(120);
  });

  it('treats % _ and SQL syntax as literal text and keeps the schema intact', () => {
    createNote(db, { bodyMd: '100% done' }, T);
    createNote(db, { bodyMd: 'a_b' }, T);
    createNote(db, { bodyMd: 'axb' }, T);
    expect(search(db, '0% d')).toHaveLength(1);
    expect(search(db, '%%')).toHaveLength(0);
    expect(search(db, 'a_b')).toHaveLength(1);
    expect(search(db, '\\')).toHaveLength(0);
    expect(search(db, "'; DROP TABLE notes; --")).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 3 });
  });

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) createNote(db, { bodyMd: `match ${i}` }, T);
    expect(search(db, 'match', 3)).toHaveLength(3);
  });

  it('does not match JSON syntax inside the aliases column', () => {
    createPerson(db, { name: 'Bo', aliases: ['Bobby'] }, T);
    expect(search(db, '":["')).toEqual([]);
    expect(search(db, '[')).toEqual([]);
  });

  it('folds case beyond ASCII in both directions', () => {
    const p = createPerson(db, { name: 'Åsa Öster', aliases: ['Zoë'] }, T);
    createNote(db, { bodyMd: 'möte med Björn på café' }, T);
    createNote(db, { bodyMd: 'MÖTE ÄR VIKTIGT, CAFÉ' }, T);
    expect(search(db, 'åsa')).toMatchObject([{ kind: 'person', id: p.id }]);
    expect(search(db, 'ÅSA')).toMatchObject([{ kind: 'person', id: p.id }]);
    expect(search(db, 'ÖSTER')).toMatchObject([{ kind: 'person', id: p.id }]);
    expect(search(db, 'öster')).toHaveLength(1);
    expect(search(db, 'ZOË')[0]).toMatchObject({ kind: 'person', title: 'Åsa Öster', snippet: 'Zoë' });
    expect(search(db, 'MÖTE')).toHaveLength(2);
    expect(search(db, 'möte')).toHaveLength(2);
    expect(search(db, 'ärv')).toHaveLength(0);
    expect(search(db, 'är v')).toHaveLength(1);
    expect(search(db, 'CAFÉ')).toHaveLength(2);
    expect(search(db, 'café')).toHaveLength(2);
    expect(search(db, 'BJÖRN')).toHaveLength(1);
  });

  it('matches decomposed input against composed text (NFC)', () => {
    createNote(db, { bodyMd: 'Åsa' }, T);
    expect(search(db, 'a\u030Asa')).toHaveLength(1);
  });

  it('gives every kind a fair share instead of letting notes crowd out the rest', () => {
    const p = createPerson(db, { name: 'Budgetia' }, T);
    updateMeetingNotes(db, startMeeting(db, p.id, T)!.meeting.id, 'budget sync');
    for (let i = 0; i < 20; i++) createNote(db, { bodyMd: `budget note ${i}` }, T);
    const res = search(db, 'budget', 10);
    expect(res).toHaveLength(10);
    expect(res.map((r) => r.kind).slice(0, 2)).toEqual(['person', 'meeting']);
    expect(res.filter((r) => r.kind === 'note')).toHaveLength(8);
    // kinds with few matches leave their unused slots to the ones with more
    expect(search(db, 'budget', 50).filter((r) => r.kind === 'note')).toHaveLength(20);
  });

  it('orders people, meetings, notes, actions, agenda and respects tiny limits', () => {
    const p = createPerson(db, { name: 'Zed' }, T);
    createAgendaItem(db, { personId: p.id, text: 'zed topic' }, T);
    createAction(db, { text: 'zed action' }, T);
    createNote(db, { bodyMd: 'zed note' }, T);
    updateMeetingNotes(db, startMeeting(db, p.id, T)!.meeting.id, 'zed meeting');
    expect(search(db, 'zed').map((r) => r.kind)).toEqual(['person', 'meeting', 'note', 'action', 'agenda']);
    expect(search(db, 'zed', 3).map((r) => r.kind)).toEqual(['person', 'meeting', 'note']);
  });

  it('keeps archived people searchable and marks them (also on their meetings)', () => {
    const live = createPerson(db, { name: 'Livia' }, T);
    const old = createPerson(db, { name: 'Olle Livia' }, T);
    updateMeetingNotes(db, startMeeting(db, old.id, T)!.meeting.id, 'livia notes');
    updateMeetingNotes(db, startMeeting(db, live.id, T)!.meeting.id, 'livia notes too');
    updatePerson(db, old.id, { archived: true }, T);
    const res = search(db, 'livia');
    expect(res.filter((r) => r.kind === 'person').map((r) => [r.id, r.archived]).sort()).toEqual([[live.id, false], [old.id, true]]);
    expect(res.filter((r) => r.kind === 'meeting').map((r) => [r.personId, r.archived]).sort()).toEqual([[live.id, false], [old.id, true]]);
    createNote(db, { bodyMd: 'livia note' }, T);
    expect(search(db, 'livia').find((r) => r.kind === 'note')!.archived).toBe(false);
  });

  it('keeps the match inside the snippet when lower-casing changes the length', () => {
    // 'İ'.toLowerCase() is two UTF-16 units, which shifts folded offsets against the original text.
    createNote(db, { bodyMd: `${'İ'.repeat(70)} needle ${'İ'.repeat(70)}` }, T);
    createNote(db, { bodyMd: `${'ß'.repeat(70)} Needle ${'ẞ'.repeat(70)}` }, T);
    const res = search(db, 'needle');
    expect(res).toHaveLength(2);
    for (const r of res) expect(r.snippet.toLowerCase()).toContain('needle');
  });

  it('folds capital sigma consistently with the snippet offsets', () => {
    createNote(db, { bodyMd: `ΟΔΟΣ ${'x'.repeat(5)} Σάββατο needle ΟΔΟΣ` }, T);
    expect(search(db, 'οδοσ')).toHaveLength(1);
    expect(search(db, 'σάββατο')).toHaveLength(1);
    expect(search(db, 'needle')[0]!.snippet).toContain('needle');
    expect(fold('ΟΔΟΣ')).toBe('οδοσ');
    expect(fold('Åsa Ö')).toBe('åsa ö');
  });
});

