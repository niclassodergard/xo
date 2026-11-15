import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';
import { resetFocusTargets } from './focus.ts';
import { docPath, isPinned, openDoc, pinTargetOf, togglePin } from './nav.ts';
import { route } from './router.ts';
import { nav, people, projects, refreshNav, session } from './store.ts';

afterEach(() => { vi.restoreAllMocks(); session.value = null; resetFocusTargets(); nav.value = { pinned: [], recents: [] }; });

describe('docPath', () => {
  it('maps every DocRef to its route path', () => {
    expect(docPath({ kind: 'person', id: 3 })).toBe('/people/3');
    expect(docPath({ kind: 'project', id: 4 })).toBe('/projects/4');
    expect(docPath({ kind: 'meeting', id: 5 })).toBe('/meetings/5');
    expect(docPath({ kind: 'note', id: 6 })).toBe('/notes/6');
    for (const k of ['actions', 'notes', 'people', 'projects'] as const) expect(docPath({ kind: k })).toBe(`/${k}`);
  });
});

describe('openDoc', () => {
  it('navigates', () => {
    openDoc({ kind: 'project', id: 9 }, { focus: false });
    expect(route.value).toEqual({ name: 'project', params: { id: '9' } });
    openDoc({ kind: 'actions' });
    expect(route.value.name).toBe('actions');
  });
});

describe('isPinned', () => {
  it('reads the nav store', () => {
    nav.value = { pinned: [{ kind: 'project', id: 2, title: 'X', archived: false }], recents: [] };
    expect(isPinned('project', 2)).toBe(true);
    expect(isPinned('person', 2)).toBe(false);
    nav.value = { pinned: [], recents: [] };
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('recents', () => {
  it('openDoc records person, project, meeting and note, then reloads the nav lists', async () => {
    session.value = { csrfToken: 't' };
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    const get = vi.spyOn(api, 'get').mockResolvedValue({ pinned: [], recents: [{ kind: 'note', id: 4, title: 'N', archived: false }] });
    openDoc({ kind: 'person', id: 1 }, { focus: false });
    openDoc({ kind: 'project', id: 2 }, { focus: false });
    openDoc({ kind: 'meeting', id: 3 }, { focus: false });
    openDoc({ kind: 'note', id: 4 }, { focus: false });
    await flush();
    expect(post.mock.calls).toEqual([
      ['/api/nav/recents', { kind: 'person', id: 1 }],
      ['/api/nav/recents', { kind: 'project', id: 2 }],
      ['/api/nav/recents', { kind: 'meeting', id: 3 }],
      ['/api/nav/recents', { kind: 'note', id: 4 }],
    ]);
    expect(get).toHaveBeenCalledWith('/api/nav');
    expect(nav.value.recents).toHaveLength(1);
  });

  it('list documents are not recents', async () => {
    session.value = { csrfToken: 't' };
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    openDoc({ kind: 'people' }, { focus: false });
    openDoc({ kind: 'actions' }, { focus: false });
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it('a route change alone (a link, Back, a typed URL) records nothing', async () => {
    session.value = { csrfToken: 't' };
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined);
    route.value = { name: 'person', params: { id: '7' } };
    route.value = { name: 'project', params: { id: '8' } };
    await flush();
    expect(post).not.toHaveBeenCalled();
  });

  it('records nothing without a session, and a failed request is silent', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValue(new Error('x'));
    openDoc({ kind: 'person', id: 1 }, { focus: false });
    await flush();
    expect(post).not.toHaveBeenCalled();
    session.value = { csrfToken: 't' };
    openDoc({ kind: 'person', id: 1 }, { focus: false });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('togglePin', () => {
  it('pins optimistically, calls PUT, then reloads', async () => {
    session.value = { csrfToken: 't' };
    projects.value = [{ id: 5, title: 'Apollo', aliases: [], status: 'active', openActions: 0, updatedAt: '' }];
    let release!: () => void;
    const put = vi.spyOn(api, 'put').mockImplementation(() => new Promise((r) => { release = () => r(undefined); }));
    const get = vi.spyOn(api, 'get').mockResolvedValue({ pinned: [{ kind: 'project', id: 5, title: 'Apollo', archived: false }], recents: [] });
    const p = togglePin('project', 5);
    expect(isPinned('project', 5)).toBe(true);
    expect(put).toHaveBeenCalledWith('/api/nav/pins/project/5');
    release();
    await p;
    expect(get).toHaveBeenCalledWith('/api/nav');
    projects.value = [];
  });

  it('a second press while one is in flight neither flips the UI nor sends a request', async () => {
    session.value = { csrfToken: 't' };
    nav.value = { pinned: [{ kind: 'person', id: 2, title: 'Anna', archived: false }], recents: [] };
    let release!: () => void;
    const del = vi.spyOn(api, 'del').mockImplementation(() => new Promise((r) => { release = () => r(undefined); }));
    vi.spyOn(api, 'get').mockResolvedValue({ pinned: [], recents: [] });
    const first = togglePin('person', 2);
    expect(isPinned('person', 2)).toBe(false);
    await togglePin('person', 2); // guard: no flip back to pinned, no second request
    expect(isPinned('person', 2)).toBe(false);
    expect(del).toHaveBeenCalledTimes(1);
    release();
    await first;
    // After it settled, the key is free again.
    const put = vi.spyOn(api, 'put').mockResolvedValue(undefined);
    people.value = [];
    await togglePin('person', 2);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('restores the lists and reports when the request fails', async () => {
    session.value = { csrfToken: 't' };
    const before = { pinned: [{ kind: 'person' as const, id: 2, title: 'Anna', archived: false }], recents: [] };
    nav.value = before;
    vi.spyOn(api, 'del').mockRejectedValue(new Error('boom'));
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    await togglePin('person', 2);
    expect(nav.value).toEqual(before);
  });
});

describe('pinTargetOf', () => {
  it('only person and project routes with a valid id', () => {
    expect(pinTargetOf({ name: 'person', params: { id: '4' } })).toEqual({ kind: 'person', id: 4 });
    expect(pinTargetOf({ name: 'project', params: { id: '9' } })).toEqual({ kind: 'project', id: 9 });
    expect(pinTargetOf({ name: 'note', params: { id: '9' } })).toBeNull();
    expect(pinTargetOf({ name: 'person', params: { id: 'x' } })).toBeNull();
    expect(pinTargetOf({ name: 'home', params: {} })).toBeNull();
  });
});

describe('refreshNav ordering', () => {
  it('applies only the newest response when they arrive out of order', async () => {
    session.value = { csrfToken: 't' };
    const resolvers: ((v: unknown) => void)[] = [];
    vi.spyOn(api, 'get').mockImplementation(() => new Promise((r) => { resolvers.push(r); }));
    const older = refreshNav();
    const newer = refreshNav();
    resolvers[1]!({ pinned: [], recents: [{ kind: 'note', id: 2, title: 'new', archived: false }] });
    await newer;
    resolvers[0]!({ pinned: [], recents: [{ kind: 'note', id: 1, title: 'old', archived: false }] });
    await older;
    expect(nav.value.recents.map((r) => r.title)).toEqual(['new']);
  });

  it('a failed toggle restores only the pins, keeping a recents refresh that landed meanwhile', async () => {
    session.value = { csrfToken: 't' };
    const pin = { kind: 'person' as const, id: 2, title: 'Anna', archived: false };
    nav.value = { pinned: [pin], recents: [] };
    let fail!: (e: Error) => void;
    vi.spyOn(api, 'del').mockImplementation(() => new Promise((_, rej) => { fail = rej; }));
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    const p = togglePin('person', 2);
    nav.value = { pinned: [], recents: [{ kind: 'note', id: 9, title: 'N', archived: false }] }; // a refresh landed
    fail(new Error('boom'));
    await p;
    expect(nav.value.pinned).toEqual([pin]);
    expect(nav.value.recents).toHaveLength(1);
  });
});

describe('optimistic pin vs an in-flight GET', () => {
  it('a GET started before the optimistic flip cannot undo it when it lands late', async () => {
    session.value = { csrfToken: 't' };
    const pin = { kind: 'person' as const, id: 2, title: 'Anna', archived: false };
    nav.value = { pinned: [pin], recents: [] };
    const gets: ((v: unknown) => void)[] = [];
    vi.spyOn(api, 'get').mockImplementation(() => new Promise((r) => { gets.push(r); }));
    let release!: () => void;
    vi.spyOn(api, 'del').mockImplementation(() => new Promise((r) => { release = () => r(undefined); }));
    const early = refreshNav(); // e.g. after a recents POST
    const toggle = togglePin('person', 2); // optimistic unpin
    expect(isPinned('person', 2)).toBe(false);
    gets[0]!({ pinned: [pin], recents: [] }); // stale: still shows the pin
    await early;
    expect(isPinned('person', 2)).toBe(false);
    release();
    await new Promise((r) => setTimeout(r, 0));
    gets[1]!({ pinned: [], recents: [] });
    await toggle;
    expect(isPinned('person', 2)).toBe(false);
  });
});
