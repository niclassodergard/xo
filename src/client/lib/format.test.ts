import { describe, expect, it } from 'vitest';
import { appendPage, formatAliases, formatWhen, mayHaveMore, oldestId, oneLine, parseAliases, shortDate } from './format.ts';

describe('format helpers', () => {
  it('oneLine collapses whitespace and optionally cuts', () => {
    expect(oneLine('  a \n b\t c ')).toBe('a b c');
    expect(oneLine('abcdefghij', 5)).toBe('abcd…');
    expect(oneLine('abc', 5)).toBe('abc');
  });
  it('shortDate and formatWhen never throw', () => {
    expect(shortDate('2026-11-15T10:00:00Z')).toBe('2026-11-15');
    expect(shortDate('nope')).toBe('');
    expect(formatWhen('garbage')).toBe('garbage');
    expect(formatWhen('2026-11-15T10:00:00')).toMatch(/^2026-11-15 \d\d:\d\d$/);
  });
  it('aliases: trimmed, blanks and case-insensitive duplicates removed, Swedish letters folded', () => {
    expect(parseAliases(' Ann, annie ,, ANN, Åsa, åsa ')).toEqual(['Ann', 'annie', 'Åsa']);
    expect(formatAliases(['a', 'b'])).toBe('a, b');
  });
  it('paging helpers', () => {
    expect(mayHaveMore(50, 50)).toBe(true);
    expect(mayHaveMore(49, 50)).toBe(false);
    expect(appendPage([{ id: 3 }, { id: 2 }], [{ id: 2 }, { id: 1 }]).map((i) => i.id)).toEqual([3, 2, 1]);
    expect(oldestId([{ id: 3 }, { id: 1 }, { id: 2 }])).toBe(1);
    expect(oldestId([])).toBeUndefined();
  });
});
