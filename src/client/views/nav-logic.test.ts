import { describe, expect, it } from 'vitest';
import { cycleView } from './nav-logic.ts';

const NAV = [
  { href: '/chat', names: ['chat'] },
  { href: '/actions', names: ['actions'] },
  { href: '/notes', names: ['notes', 'note'] },
  { href: '/people', names: ['people', 'person', 'meeting'] },
];

describe('cycleView', () => {
  it('steps forward and wraps', () => {
    expect(cycleView(NAV, 'chat', 1)).toBe('/actions');
    expect(cycleView(NAV, 'actions', 1)).toBe('/notes');
    expect(cycleView(NAV, 'notes', 1)).toBe('/people');
    expect(cycleView(NAV, 'people', 1)).toBe('/chat');
  });
  it('steps backward and wraps', () => {
    expect(cycleView(NAV, 'chat', -1)).toBe('/people');
    expect(cycleView(NAV, 'people', -1)).toBe('/notes');
  });
  it('detail routes count as their section', () => {
    expect(cycleView(NAV, 'note', 1)).toBe('/people');
    expect(cycleView(NAV, 'person', 1)).toBe('/chat');
    expect(cycleView(NAV, 'meeting', -1)).toBe('/notes');
  });
  it('routes outside the sections enter at either end', () => {
    expect(cycleView(NAV, 'search', 1)).toBe('/chat');
    expect(cycleView(NAV, 'search', -1)).toBe('/people');
    expect(cycleView(NAV, 'notfound', 1)).toBe('/chat');
  });
  it('is safe with no entries', () => {
    expect(cycleView([], 'chat', 1)).toBe('/chat');
  });
});
