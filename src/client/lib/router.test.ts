import { describe, expect, it } from 'vitest';
import { backAction, formatRoute, parentPath, parseRoute } from './router.ts';

describe('parseRoute', () => {
  it('defaults to chat', () => {
    for (const h of ['', '#', '#/', '/']) expect(parseRoute(h).name).toBe('chat');
  });
  it('parses top-level views', () => {
    for (const n of ['chat', 'actions', 'notes', 'people', 'search']) {
      expect(parseRoute(`#/${n}`)).toEqual({ name: n, params: {} });
    }
  });
  it('parses id routes', () => {
    expect(parseRoute('#/notes/12')).toEqual({ name: 'note', params: { id: '12' } });
    expect(parseRoute('#/people/3')).toEqual({ name: 'person', params: { id: '3' } });
    expect(parseRoute('#/meetings/7')).toEqual({ name: 'meeting', params: { id: '7' } });
  });
  it('ignores a query string it does not support as part of the path', () => {
    expect(parseRoute('#/people/3?x=1').name).toBe('notfound');
  });
  it('rejects non-numeric ids, unknown paths and extra segments', () => {
    for (const h of ['#/notes/abc', '#/people/1/2', '#/people/../x', '#/nope', '#/meetings', '#/notes/%E0%A4%A', '#/people/1;drop']) {
      expect(parseRoute(h).name).toBe('notfound');
    }
  });
});

describe('formatRoute', () => {
  it('round-trips', () => {
    for (const p of ['/chat', '/actions', '/notes', '/notes/4', '/people', '/people/9', '/meetings/2', '/search']) {
      const r = parseRoute(p);
      expect(formatRoute(r)).toBe(p);
    }
  });
});

describe('parentPath', () => {
  it('maps detail views to their list', () => {
    expect(parentPath(parseRoute('#/notes/1'))).toBe('/notes');
    expect(parentPath(parseRoute('#/people/1'))).toBe('/people');
    expect(parentPath(parseRoute('#/meetings/1'))).toBe('/people');
    expect(parentPath(parseRoute('#/actions'))).toBe('/chat');
  });
});

describe('backAction', () => {
  it('only uses history when the app pushed an entry', () => {
    expect(backAction(0)).toBe('parent');
    expect(backAction(1)).toBe('history');
    expect(backAction(3)).toBe('history');
  });
});
