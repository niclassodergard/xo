import { describe, expect, it } from 'vitest';
import type { Person } from '../../shared/types.ts';
import type { ProjectSummary } from '../../shared/api.ts';
import { addPerson, groupProjects, isStatus, openCountLabel, removePerson, sameAliases } from './project-logic.ts';
import { parseAliases } from '../lib/format.ts';

const proj = (id: number, title: string, status: ProjectSummary['status'], openActions = 0): ProjectSummary =>
  ({ id, title, aliases: [], status, openActions, updatedAt: '2026-01-01T00:00:00Z' });
const person = (id: number, name: string): Person =>
  ({ id, name, aliases: [], notesMd: '', createdAt: '', updatedAt: '', archivedAt: null });

describe('groupProjects', () => {
  it('orders the groups Active, On hold, Done and keeps the order inside a group', () => {
    const g = groupProjects([proj(1, 'B', 'done'), proj(2, 'Åre', 'active'), proj(3, 'C', 'on_hold'), proj(4, 'Z', 'active')]);
    expect(g.map((x) => x.label)).toEqual(['Active', 'On hold', 'Done']);
    expect(g[0]!.items.map((p) => p.id)).toEqual([2, 4]);
    expect(g[1]!.items.map((p) => p.id)).toEqual([3]);
    expect(g[2]!.items.map((p) => p.id)).toEqual([1]);
  });
  it('returns all three groups, empty ones included', () => {
    expect(groupProjects([]).map((x) => x.items.length)).toEqual([0, 0, 0]);
  });
});

describe('small helpers', () => {
  it('openCountLabel hides zero', () => {
    expect(openCountLabel(0)).toBe('');
    expect(openCountLabel(3)).toBe('3 open');
  });
  it('isStatus accepts only the three statuses', () => {
    expect(isStatus('on_hold')).toBe(true);
    expect(isStatus('toString')).toBe(false);
    expect(isStatus('')).toBe(false);
  });
});

describe('alias parsing and comparison', () => {
  it('parses a comma list, dropping blanks and case-insensitive duplicates', () => {
    expect(parseAliases('Apollo, apollo, , Åre ,Åre')).toEqual(['Apollo', 'Åre']);
  });
  it('sameAliases compares order and content', () => {
    expect(sameAliases(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameAliases(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameAliases([], ['a'])).toBe(false);
  });
});

describe('people list logic', () => {
  it('adds a person once and keeps the list sorted (Swedish collation)', () => {
    let l: Person[] = [person(1, 'Bo'), person(2, 'Örjan')];
    l = addPerson(l, person(3, 'Åsa'));
    expect(l.map((p) => p.name)).toEqual(['Bo', 'Åsa', 'Örjan']);
    expect(addPerson(l, person(3, 'Åsa'))).toBe(l);
  });
  it('removes by id and ignores an unknown id', () => {
    const l = [person(1, 'Bo'), person(2, 'Cia')];
    expect(removePerson(l, 1).map((p) => p.id)).toEqual([2]);
    expect(removePerson(l, 9)).toHaveLength(2);
  });
});
