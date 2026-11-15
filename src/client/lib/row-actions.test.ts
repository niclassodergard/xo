import { describe, expect, it } from 'vitest';
import { stepAction, stepRow } from './row-actions.ts';

describe('stepAction', () => {
  const ids = ['open', 'undo', 'reclassify'];
  it('with nothing highlighted Right picks the first and Left the last', () => {
    expect(stepAction(ids, null, 'right')).toBe('open');
    expect(stepAction(ids, null, 'left')).toBe('reclassify');
  });
  it('steps and clamps at both ends (no wrap)', () => {
    expect(stepAction(ids, 'open', 'right')).toBe('undo');
    expect(stepAction(ids, 'reclassify', 'right')).toBe('reclassify');
    expect(stepAction(ids, 'undo', 'left')).toBe('open');
    expect(stepAction(ids, 'open', 'left')).toBe('open');
  });
  it('a stale id starts over; no chips gives null', () => {
    expect(stepAction(ids, 'gone', 'right')).toBe('open');
    expect(stepAction([], null, 'right')).toBeNull();
    expect(stepAction([], 'x', 'left')).toBeNull();
  });
});

describe('stepRow', () => {
  it('Down from nothing picks the first, Up the last; moves clamp', () => {
    expect(stepRow(3, -1, 'down')).toBe(0);
    expect(stepRow(3, -1, 'up')).toBe(2);
    expect(stepRow(3, 0, 'down')).toBe(1);
    expect(stepRow(3, 2, 'down')).toBe(2);
    expect(stepRow(3, 0, 'up')).toBe(0);
  });
  it('an index past the end (rows removed) starts over; an empty list gives -1', () => {
    expect(stepRow(2, 5, 'down')).toBe(0);
    expect(stepRow(0, 0, 'down')).toBe(-1);
  });
});
