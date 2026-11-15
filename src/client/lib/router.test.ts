import { describe, expect, it } from 'vitest';
import { backAction, closeAction, formatRoute, isPanelRoute, navigate, parentPath, parseRoute, route } from './router.ts';

describe('parseRoute', () => {
  it('home, including the legacy #/chat and #/search', () => {
    for (const h of ['', '#', '#/', '/', '#/chat', '#/search', '/chat']) {
      expect(parseRoute(h)).toEqual({ name: 'home', params: {} });
    }
  });
  it('parses the four list routes', () => {
    for (const n of ['actions', 'notes', 'people', 'projects']) {
      expect(parseRoute(`#/${n}`)).toEqual({ name: n, params: {} });
    }
  });
  it('parses id routes', () => {
    expect(parseRoute('#/notes/12')).toEqual({ name: 'note', params: { id: '12' } });
    expect(parseRoute('#/people/3')).toEqual({ name: 'person', params: { id: '3' } });
    expect(parseRoute('#/projects/5')).toEqual({ name: 'project', params: { id: '5' } });
    expect(parseRoute('#/meetings/7')).toEqual({ name: 'meeting', params: { id: '7' } });
  });
  it('does not accept a query string as part of the path', () => {
    expect(parseRoute('#/people/3?x=1').name).toBe('notfound');
    expect(parseRoute('#/projects?q=a').name).toBe('notfound');
  });
  it('rejects bad ids, unknown paths and extra segments', () => {
    for (const h of [
      '#/notes/abc', '#/people/1/2', '#/people/../x', '#/nope', '#/meetings', '#/notes/%E0%A4%A', '#/people/1;drop',
      '#/projects/-1', '#/projects/1.5', '#/projects/1234567890123456', '#/chat/1', '#/search/x', '#/actions/1', '#/projects/',
    ]) {
      expect(parseRoute(h).name, h).toBe(h === '#/projects/' ? 'projects' : 'notfound');
    }
  });
  it('mixed-case paths are not routes (paths are exact)', () => {
    expect(parseRoute('#/People').name).toBe('notfound');
    expect(parseRoute('#/Projects/2').name).toBe('notfound');
  });
});

describe('formatRoute', () => {
  it('round-trips every route', () => {
    for (const p of ['/actions', '/notes', '/notes/4', '/people', '/people/9', '/projects', '/projects/3', '/meetings/2']) {
      expect(formatRoute(parseRoute(p))).toBe(p);
    }
    expect(formatRoute(parseRoute('/'))).toBe('/');
    expect(formatRoute(parseRoute('#/chat'))).toBe('/');
    expect(formatRoute({ name: 'notfound' })).toBe('/');
  });
});

describe('panel routes', () => {
  it('everything but home shows a panel', () => {
    expect(isPanelRoute(parseRoute('/'))).toBe(false);
    for (const p of ['/actions', '/people/1', '/projects', '/nope']) expect(isPanelRoute(parseRoute(p))).toBe(true);
  });
});

describe('parentPath', () => {
  it('maps detail documents to their list and everything else to home', () => {
    expect(parentPath(parseRoute('#/notes/1'))).toBe('/notes');
    expect(parentPath(parseRoute('#/people/1'))).toBe('/people');
    expect(parentPath(parseRoute('#/projects/1'))).toBe('/projects');
    expect(parentPath(parseRoute('#/meetings/1'))).toBe('/people');
    expect(parentPath(parseRoute('#/actions'))).toBe('/');
    expect(parentPath(parseRoute('#/people'))).toBe('/');
  });
});

describe('backAction', () => {
  it('only uses history when the app pushed an entry', () => {
    expect(backAction(0)).toBe('parent');
    expect(backAction(1)).toBe('history');
    expect(backAction(3)).toBe('history');
  });
});

describe('navigate (no window)', () => {
  it('sets the route signal and sends unknown paths home', () => {
    navigate('/projects/4');
    expect(route.value).toEqual({ name: 'project', params: { id: '4' } });
    navigate('/nope');
    expect(route.value.name).toBe('home');
    navigate('people');
    expect(route.value.name).toBe('people');
    navigate('/');
  });
});

describe('closeAction', () => {
  it('goes back in history only when the entry just left was home and this app pushed the entry', () => {
    expect(closeAction({ depth: 1, prev: '/' })).toBe('history');
    expect(closeAction({ depth: 2, prev: '/' })).toBe('history');
    expect(closeAction({ depth: 2, prev: '/people' })).toBe('replace');
    expect(closeAction({ depth: 0, prev: '/' })).toBe('replace');
    expect(closeAction(null)).toBe('replace');
    expect(closeAction({ depth: 1 })).toBe('replace');
  });
});
