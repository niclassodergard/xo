import { describe, expect, it } from 'vitest';
import type { SearchHit } from '../../shared/api.ts';
import {
  buildRows, createSearchTickets, groupStarts, hitToRef, localMatches, LOCAL_PER_KIND, reselect, shouldSearch,
} from './palette-logic.ts';

const person = (id: number, name: string, aliases: string[] = [], archivedAt: string | null = null) => ({ id, name, aliases, archivedAt });
const project = (id: number, title: string, aliases: string[] = []) => ({ id, title, aliases });
const hit = (kind: SearchHit['kind'], id: number, extra: Partial<SearchHit> = {}): SearchHit =>
  ({ kind, id, title: `t${id}`, snippet: '', personId: null, archived: false, ...extra });

describe('shouldSearch', () => {
  it('needs two characters after trimming', () => {
    expect(shouldSearch('')).toBe(false);
    expect(shouldSearch(' a ')).toBe(false);
    expect(shouldSearch('ab')).toBe(true);
    expect(shouldSearch('  ab ')).toBe(true);
  });
});

describe('hitToRef', () => {
  it('maps all six kinds', () => {
    expect(hitToRef(hit('note', 1))).toEqual({ kind: 'note', id: 1 });
    expect(hitToRef(hit('person', 2))).toEqual({ kind: 'person', id: 2 });
    expect(hitToRef(hit('project', 3))).toEqual({ kind: 'project', id: 3 });
    expect(hitToRef(hit('meeting', 4))).toEqual({ kind: 'meeting', id: 4 });
    expect(hitToRef(hit('action', 5, { personId: 9 }))).toEqual({ kind: 'person', id: 9 });
    expect(hitToRef(hit('agenda', 6, { personId: 8 }))).toEqual({ kind: 'person', id: 8 });
  });
  it('falls back to the list when an action or agenda item has no person', () => {
    expect(hitToRef(hit('action', 5))).toEqual({ kind: 'actions' });
    expect(hitToRef(hit('agenda', 6))).toEqual({ kind: 'people' });
  });
});

describe('localMatches', () => {
  it('matches names and aliases with Unicode case folding', () => {
    const r = localMatches('åsa', [person(1, 'Åsa Berg'), person(2, 'Bo', ['ÅSA-B'])], [project(3, 'Projekt ÅSA')]);
    expect(r.map((m) => `${m.kind}:${m.id}`)).toEqual(['person:1', 'person:2', 'project:3']);
  });
  it('handles decomposed (NFD) input', () => {
    expect(localMatches('Åsa', [person(1, 'Åsa')], [])).toHaveLength(1);
  });
  it('lists archived people last, prefix matches first, and caps each kind', () => {
    const r = localMatches('an', [person(1, 'Hanna'), person(2, 'Anna', [], '2026-01-01'), person(3, 'Anders')], []);
    expect(r.map((m) => m.id)).toEqual([3, 1, 2]);
    expect(r[2]!.archived).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => person(i + 1, `Ann ${i}`));
    expect(localMatches('ann', many, [])).toHaveLength(LOCAL_PER_KIND);
  });
  it('empty query matches nothing', () => {
    expect(localMatches('  ', [person(1, 'Anna')], [project(2, 'X')])).toEqual([]);
  });
});

describe('buildRows', () => {
  const cmds = [{ id: 'a', title: 'Go to Actions' }];
  it('orders commands, names, then server hits, and groups them', () => {
    const names = localMatches('an', [person(1, 'Anna')], [project(2, 'Annex')]);
    const rows = buildRows(cmds, names, [hit('note', 7, { snippet: 'about anna' })]);
    expect(rows.map((r) => r.key)).toEqual(['cmd:a', 'name:person:1', 'name:project:2', 'hit:note:7']);
    expect([...groupStarts(rows)]).toEqual([[0, 'commands'], [1, 'names'], [3, 'search']]);
    const last = rows[3]!;
    expect(last.group === 'search' && last.sub).toBe('Note · about anna');
    expect(last.group === 'search' && last.ref).toEqual({ kind: 'note', id: 7 });
  });
  it('drops a server hit for a person or project already listed by name, keeps other kinds', () => {
    const names = localMatches('anna', [person(1, 'Anna')], []);
    const rows = buildRows([], names, [hit('person', 1), hit('person', 9), hit('action', 1, { personId: 1 })]);
    expect(rows.map((r) => r.key)).toEqual(['name:person:1', 'hit:person:9', 'hit:action:1']);
  });
  it('marks archived hits', () => {
    const rows = buildRows([], [], [hit('person', 3, { archived: true })]);
    expect(rows[0]!.group === 'search' && rows[0]!.sub).toBe('Person (archived)');
  });
});

describe('reselect', () => {
  it('keeps the selected row when it is still there, else the first', () => {
    const rows = buildRows([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], [], []);
    expect(reselect('cmd:b', rows)).toBe(1);
    expect(reselect('cmd:gone', rows)).toBe(0);
    expect(reselect(null, rows)).toBe(0);
  });
});

describe('search tickets (stale responses)', () => {
  it('only the newest ticket is current', () => {
    const t = createSearchTickets();
    const a = t.begin(1);
    const b = t.begin(1);
    expect(t.isCurrent(a, 1)).toBe(false);
    expect(t.isCurrent(b, 1)).toBe(true);
  });
  it('a response from another session epoch is dropped', () => {
    const t = createSearchTickets();
    const a = t.begin(1);
    expect(t.isCurrent(a, 2)).toBe(false);
  });
  it('cancel makes outstanding tickets stale', () => {
    const t = createSearchTickets();
    const a = t.begin(1);
    t.cancel();
    expect(t.isCurrent(a, 1)).toBe(false);
  });
});
