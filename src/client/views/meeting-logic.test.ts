import { describe, expect, it } from 'vitest';
import type { Action, AgendaItem, Meeting, MeetingDetail, Person } from '../../shared/types.ts';
import {
  actionRows, agendaMark, agendaProgress, appendPage, buildView, cyclePane, formatAliases, formatWhen, isActive, mayHaveMore,
  mergeAgenda, oneLine, parseAliases, removeById, replaceById, splitByOwner, toggleAgenda, toggleRequest,
} from './meeting-logic.ts';

const item = (id: number, over: Partial<AgendaItem> = {}): AgendaItem => ({
  id, personId: 1, text: `item ${id}`, status: 'open', createdAt: '2026-01-01T00:00:00.000Z', resolvedAt: null, resolvedMeetingId: null, ...over,
});
const action = (id: number, over: Partial<Action> = {}): Action => ({
  id, text: `action ${id}`, owner: 'me', status: 'open', personId: 1, meetingId: null, createdAt: '2026-01-01T00:00:00.000Z', doneAt: null, ...over,
});
const meeting = (over: Partial<Meeting> = {}): Meeting => ({ id: 5, personId: 1, startedAt: '2026-01-02T10:00:00.000Z', endedAt: null, notesMd: '', ...over });
const person: Person = { id: 1, name: 'Anna', aliases: [], notesMd: '', createdAt: '', updatedAt: '', archivedAt: null };
const detail = (over: Partial<MeetingDetail> = {}): MeetingDetail => ({
  meeting: meeting(), person, openAgenda: [], resolvedHere: [], actionsHere: [], otherOpenActions: [], previous: null, ...over,
});

describe('mergeAgenda', () => {
  it('interleaves open and resolved items in creation order', () => {
    const merged = mergeAgenda([item(1), item(3)], [item(2, { status: 'done', resolvedMeetingId: 5 })]);
    expect(merged.map((i) => i.id)).toEqual([1, 2, 3]);
  });
  it('lets the resolved copy win when an id appears twice, and handles empty input', () => {
    const merged = mergeAgenda([item(1)], [item(1, { status: 'done' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.status).toBe('done');
    expect(mergeAgenda([], [])).toEqual([]);
  });
});

describe('buildView', () => {
  it('shows open and resolved agenda plus earlier open actions for an active meeting', () => {
    const v = buildView(detail({
      openAgenda: [item(1), item(3)], resolvedHere: [item(2, { status: 'done' })],
      actionsHere: [action(10)], otherOpenActions: [action(11)],
    }));
    expect(v.active).toBe(true);
    expect(v.agenda.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(v.here.map((a) => a.id)).toEqual([10]);
    expect(v.earlier.map((a) => a.id)).toEqual([11]);
  });
  it('shows only what was resolved in an ended meeting, never the person\'s current open agenda', () => {
    const v = buildView(detail({
      meeting: meeting({ endedAt: '2026-01-02T11:00:00.000Z' }),
      openAgenda: [item(1), item(3)], resolvedHere: [item(2, { status: 'done' })], otherOpenActions: [action(11)],
    }));
    expect(v.active).toBe(false);
    expect(v.agenda.map((i) => i.id)).toEqual([2]);
    expect(v.earlier).toEqual([]);
  });
  it('isActive is exactly endedAt === null', () => {
    expect(isActive({ endedAt: null })).toBe(true);
    expect(isActive({ endedAt: '2026-01-02T11:00:00.000Z' })).toBe(false);
  });
});

describe('toggleAgenda', () => {
  const now = '2026-02-02T09:00:00.000Z';
  it('checks an open item into this meeting without touching the others', () => {
    const items = [item(1), item(2)];
    const next = toggleAgenda(items, 2, 5, now);
    expect(next[1]).toMatchObject({ status: 'done', resolvedAt: now, resolvedMeetingId: 5 });
    expect(next[0]).toBe(items[0]);
    expect(items[1]!.status).toBe('open'); // input not mutated
  });
  it('unchecks a resolved item and clears the resolution', () => {
    const next = toggleAgenda([item(1, { status: 'done', resolvedAt: now, resolvedMeetingId: 5 })], 1, 5, now);
    expect(next[0]).toMatchObject({ status: 'open', resolvedAt: null, resolvedMeetingId: null });
  });
  it('ignores an unknown id', () => {
    const items = [item(1)];
    expect(toggleAgenda(items, 99, 5, now)).toEqual(items);
  });
  it('toggleRequest matches the optimistic change (meetingId only when checking)', () => {
    expect(toggleRequest(item(1), 5)).toEqual({ status: 'done', meetingId: 5 });
    expect(toggleRequest(item(1, { status: 'done' }), 5)).toEqual({ status: 'open' });
    expect(toggleRequest(item(1, { status: 'dropped' }), 5)).toEqual({ status: 'open' });
  });
});

describe('list helpers', () => {
  it('replaceById swaps in place, appends when missing', () => {
    expect(replaceById([item(1), item(2)], item(2, { text: 'x' })).map((i) => i.text)).toEqual(['item 1', 'x']);
    expect(replaceById([item(1)], item(2)).map((i) => i.id)).toEqual([1, 2]);
  });
  it('removeById drops one item', () => {
    expect(removeById([item(1), item(2)], 1).map((i) => i.id)).toEqual([2]);
    expect(removeById([item(1)], 9)).toHaveLength(1);
  });
  it('actionRows puts this meeting\'s follow-ups before earlier ones and flags them', () => {
    const rows = actionRows([action(1)], [action(2)]);
    expect(rows.map((r) => [r.action.id, r.earlier])).toEqual([[1, false], [2, true]]);
  });
  it('splitByOwner separates mine and theirs', () => {
    const s = splitByOwner([action(1), action(2, { owner: 'them' }), action(3)]);
    expect(s.mine.map((a) => a.id)).toEqual([1, 3]);
    expect(s.theirs.map((a) => a.id)).toEqual([2]);
  });
  it('appendPage skips ids already shown', () => {
    expect(appendPage([item(3), item(2)], [item(2), item(1)]).map((i) => i.id)).toEqual([3, 2, 1]);
  });
  it('mayHaveMore is true only for a full page', () => {
    expect(mayHaveMore(50, 50)).toBe(true);
    expect(mayHaveMore(49, 50)).toBe(false);
    expect(mayHaveMore(0, 50)).toBe(false);
  });
});

describe('cyclePane', () => {
  it('wraps in both directions', () => {
    expect(cyclePane(0, 4, 1)).toBe(1);
    expect(cyclePane(3, 4, 1)).toBe(0);
    expect(cyclePane(0, 4, -1)).toBe(3);
    expect(cyclePane(2, 4, -1)).toBe(1);
  });
  it('is safe with no panes', () => {
    expect(cyclePane(0, 0, 1)).toBe(0);
  });
});

describe('text helpers', () => {
  it('marks items', () => {
    expect(agendaMark({ status: 'open' })).toBe('[ ]');
    expect(agendaMark({ status: 'done' })).toBe('[x]');
    expect(agendaMark({ status: 'dropped' })).toBe('[-]');
  });
  it('summarises progress', () => {
    expect(agendaProgress([])).toBe('0/0');
    expect(agendaProgress([item(1), item(2, { status: 'done' }), item(3, { status: 'dropped' })])).toBe('2/3');
  });
  it('formatWhen gives local "YYYY-MM-DD HH:mm" and passes garbage through', () => {
    expect(formatWhen('2026-11-15T14:30:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatWhen('not a date')).toBe('not a date');
  });
  it('oneLine collapses whitespace and truncates', () => {
    expect(oneLine('a\n\n  b\tc')).toBe('a b c');
    expect(oneLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(oneLine('short', 10)).toBe('short');
  });
  it('parseAliases trims, drops blanks and case-insensitive duplicates, keeps Swedish letters', () => {
    expect(parseAliases(' Ann, Annie ,, ann,Åsa , åsa')).toEqual(['Ann', 'Annie', 'Åsa']);
    expect(parseAliases('')).toEqual([]);
    expect(formatAliases(['Ann', 'Annie'])).toBe('Ann, Annie');
  });
});
