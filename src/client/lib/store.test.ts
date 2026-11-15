import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appPhase, appendVoiceDraft, chatDraft, chatStash, takeChatStash, chatDraftSource, editChatDraft, prependChatDraft, restoreChatDraft, clearDraft, drafts, epoch, flashMessage, logout, overlay, people, pickRequest, promptRequest, confirmRequest, projects, nav, refreshProjects, personName, projectTitle, toggleHelp, askConfirm,
  refreshPeople, searchQuery, session, setDraft, shellActive, syncDraft, togglePalette,
} from './store.ts';
import { createDraftSaver } from './draft-saver.ts';
import type { Flash } from './store.ts';
import { api } from './api.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  session.value = { csrfToken: 't' };
  chatDraft.value = 'unsent thought';
  searchQuery.value = 'budget';
});
afterEach(() => { vi.unstubAllGlobals(); session.value = null; shellActive.value = false; chatDraft.value = ''; searchQuery.value = ''; });

describe('logout', () => {
  it('2xx: ends the session and wipes drafts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    expect(await logout()).toBe(true);
    expect(session.value).toBeNull();
    expect(shellActive.value).toBe(false);
    expect(chatDraft.value).toBe('');
    expect(searchQuery.value).toBe('');
  });

  it('logout wipes the recall stash too', async () => {
    chatStash.value = { text: 'typed before recall', source: 'text' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await logout();
    expect(chatStash.value).toBeNull();
  });

  it('401 counts as logged out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unauthenticated', message: 'x' } }, 401)));
    expect(await logout()).toBe(true);
    expect(session.value).toBeNull();
  });

  it('network error, 403, 429 and 5xx keep the session and show a sticky error with retry', async () => {
    const failures: (() => Response)[] = [
      () => { throw new TypeError('offline'); },
      () => json({ error: { code: 'forbidden', message: 'x' } }, 403),
      () => json({ error: { code: 'rate_limited', message: 'x' } }, 429),
      () => json({ error: { code: 'internal', message: 'x' } }, 500),
    ];
    for (const fail of failures) {
      session.value = { csrfToken: 't' };
      flashMessage.value = null;
      vi.stubGlobal('fetch', vi.fn(async () => fail()));
      expect(await logout()).toBe(false);
      expect(session.value).not.toBeNull();
      expect(chatDraft.value).toBe('unsent thought');
      const f: Flash | null = flashMessage.peek();
      expect(f?.kind).toBe('error');
      expect(f?.message).toContain('still signed in');
      expect(f?.action?.label).toBe('retry');
    }
  });
});

describe('401 keeps drafts and invalidates late responses', () => {
  it('a 401 clears the session but not the drafts, and the shell stays active', async () => {
    shellActive.value = true;
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unauthenticated', message: 'x' } }, 401)));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 401 });
    expect(session.value).toBeNull();
    expect(shellActive.value).toBe(true);
    expect(chatDraft.value).toBe('unsent thought');
    expect(searchQuery.value).toBe('budget');
  });

  it('a response that arrives after the session ended does not repopulate the store', async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const before = epoch();
    const pending = refreshPeople();
    session.value = null; // session ends while the request is in flight
    expect(epoch()).toBeGreaterThan(before);
    release(json({ people: [{ id: 1, name: 'Anna', aliases: [], notesMd: '', createdAt: '', updatedAt: '', archivedAt: null }] }));
    await pending;
    expect(people.value).toEqual([]);
  });
});

describe('overlay stacking', () => {
  afterEach(() => { overlay.value = null; pickRequest.value = null; promptRequest.value = null; confirmRequest.value = null; });

  it('Cmd-K and the Shortcuts key are no-ops while a Prompt, picker or confirm is open', () => {
    promptRequest.value = { label: 'New person', onSubmit: () => {} };
    togglePalette();
    toggleHelp();
    expect(overlay.value).toBeNull();
    promptRequest.value = null;
    pickRequest.value = { kind: 'person', onPick: () => {} };
    togglePalette();
    expect(overlay.value).toBeNull();
    pickRequest.value = null;
    askConfirm('Delete?', () => {});
    expect(confirmRequest.value?.message).toBe('Delete?');
    togglePalette();
    expect(overlay.value).toBeNull();
    confirmRequest.value = null;
    togglePalette();
    expect(overlay.value).toBe('palette');
    togglePalette(); // toggles closed again
    expect(overlay.value).toBeNull();
  });
});

describe('projects, nav and names', () => {
  const summary = (id: number, title: string) => ({ id, title, aliases: [], status: 'active' as const, openActions: 0, updatedAt: '' });

  it('projects and nav are cleared when the session ends (401), not only on logout', () => {
    projects.value = [summary(1, 'Apollo')];
    nav.value = { pinned: [{ kind: 'project', id: 1, title: 'Apollo', archived: false }], recents: [] };
    people.value = [{ id: 1, name: 'Anna', aliases: [], notesMd: '', createdAt: '', updatedAt: '', archivedAt: null }];
    shellActive.value = true;
    session.value = null; // a 401: the shell stays active
    expect(shellActive.value).toBe(true);
    expect(projects.value).toEqual([]);
    expect(nav.value).toEqual({ pinned: [], recents: [] });
    expect(people.value).toEqual([]);
  });

  it('a project list that arrives after the session ended is dropped', async () => {
    let release!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { release = res; })));
    const pending = refreshProjects();
    session.value = null;
    release(json({ projects: [summary(1, 'Apollo')] }));
    await pending;
    expect(projects.value).toEqual([]);
  });

  it('personName and projectTitle look up the loaded lists and return null for unknown ids', () => {
    people.value = [{ id: 1, name: 'Anna', aliases: [], notesMd: '', createdAt: '', updatedAt: '', archivedAt: null }];
    projects.value = [summary(7, 'Åre-resa')];
    expect(personName(1)).toBe('Anna');
    expect(personName(2)).toBeNull();
    expect(personName(null)).toBeNull();
    expect(projectTitle(7)).toBe('Åre-resa');
    expect(projectTitle(8)).toBeNull();
    expect(projectTitle(null)).toBeNull();
    people.value = [];
    projects.value = [];
  });
});

describe('locked phase and drafts', () => {
  it('unmounts the views while locked (no view DOM) and only then', () => {
    expect(appPhase(false, false, false)).toBe('boot');
    expect(appPhase(true, false, false)).toBe('login');
    expect(appPhase(true, true, true)).toBe('shell');
    expect(appPhase(true, true, false)).toBe('locked'); // app.tsx renders no view in this phase
  });

  it('keeps unsaved editor drafts through a 401 but wipes them on logout', async () => {
    shellActive.value = true;
    setDraft('note-1', 'half typed');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'unauthenticated', message: 'x' } }, 401)));
    await expect(api.get('/api/people')).rejects.toMatchObject({ status: 401 });
    expect(drafts.value['note-1']).toBe('half typed');
    session.value = { csrfToken: 't' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await logout();
    expect(drafts.value).toEqual({});
  });

  it('clearDraft only removes a draft that matches what was saved', () => {
    setDraft('a', 'v1');
    setDraft('a', 'v2');
    clearDraft('a', 'v1');
    expect(drafts.value['a']).toBe('v2');
    clearDraft('a', 'v2');
    expect(drafts.value['a']).toBeUndefined();
  });
});

describe('draft cleanup and stale editors', () => {
  it('drops the draft entry when the text equals the saved value again (revert)', () => {
    syncDraft('note:1:body', 'saved text!', 'saved text');
    expect(drafts.value['note:1:body']).toBe('saved text!');
    syncDraft('note:1:body', 'saved text', 'saved text');
    expect('note:1:body' in drafts.value).toBe(false);
  });

  it('an editor mounted before a logout never saves afterwards, even after logging in again', async () => {
    const onSave = vi.fn(async () => undefined);
    const mountEpoch = epoch();
    // Same gate TextEdit uses.
    const saver = createDraftSaver('old', () => onSave, {
      canSave: () => epoch() === mountEpoch && session.peek() !== null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    // user types, then logs out, then logs in again before the autosave delay elapses
    await logout();
    session.value = { csrfToken: 'new-session' };
    expect(await saver.save('typed before logout')).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    // an editor mounted after re-login (fresh epoch) saves normally
    const e2 = epoch();
    const fresh = createDraftSaver('old', () => onSave, { canSave: () => epoch() === e2 && session.peek() !== null });
    expect(await fresh.save('new text')).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});


describe('chatDraftSource', () => {
  beforeEach(() => { chatDraft.value = ''; });
  it('is text for an empty or typed draft', () => {
    expect(chatDraftSource.value).toBe('text');
    editChatDraft('hello');
    expect(chatDraftSource.value).toBe('text');
  });
  it('dictation makes it voice; a small typed fix keeps it voice, a lot of typing turns it text', () => {
    appendVoiceDraft('call Anna about the budget');
    expect(chatDraftSource.value).toBe('voice');
    editChatDraft('call Anna about the budget.');
    expect(chatDraftSource.value).toBe('voice');
    editChatDraft('call Anna about the budget. and a long typed addition after it');
    expect(chatDraftSource.value).toBe('text');
  });
  it('typed text first, then a short dictation, stays text', () => {
    editChatDraft('a long typed thought here');
    appendVoiceDraft('a long typed thought here ok');
    expect(chatDraftSource.value).toBe('text');
  });
  it('recalled history is text even over a voice draft', () => {
    appendVoiceDraft('spoken');
    editChatDraft('older entry', true);
    expect(chatDraftSource.value).toBe('text');
  });
  it('resets when the draft is cleared (send) and on logout; a 401 keeps it', async () => {
    appendVoiceDraft('spoken words');
    session.value = null; // 401
    expect(chatDraftSource.value).toBe('voice');
    chatDraft.value = '';
    expect(chatDraftSource.value).toBe('text');
    appendVoiceDraft('again spoken');
    session.value = { csrfToken: 't' };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    await logout();
    expect(chatDraft.value).toBe('');
    editChatDraft('x');
    expect(chatDraftSource.value).toBe('text');
  });
  it('restoreChatDraft keeps the original source', () => {
    restoreChatDraft('spoken', 'voice');
    expect(chatDraftSource.value).toBe('voice');
    restoreChatDraft('typed', 'text');
    expect(chatDraftSource.value).toBe('text');
  });
});

describe('prependChatDraft', () => {
  beforeEach(() => { chatDraft.value = ''; });
  it('a restored voice text keeps the draft voice, a restored typed text does not', () => {
    prependChatDraft('spoken words', 'voice');
    expect(chatDraftSource.value).toBe('voice');
    chatDraft.value = '';
    editChatDraft('new typed');
    prependChatDraft('spoken words here', 'voice');
    expect(chatDraft.value).toBe('spoken words here new typed');
    expect(chatDraftSource.value).toBe('voice');
    chatDraft.value = '';
    editChatDraft('new typed');
    prependChatDraft('typed old', 'text');
    expect(chatDraftSource.value).toBe('text');
  });
});

describe('takeChatStash', () => {
  afterEach(() => { chatStash.value = null; });
  it('puts the stash back after a send, keeping its source, and clears it', () => {
    chatDraft.value = '';
    chatStash.value = { text: 'call Anna', source: 'voice' };
    expect(takeChatStash()).toBe(true);
    expect(chatDraft.value).toBe('call Anna');
    expect(chatDraftSource.value).toBe('voice');
    expect(chatStash.value).toBeNull();
  });
  it('a text stash stays text', () => {
    chatDraft.value = '';
    chatStash.value = { text: 'hello', source: 'text' };
    takeChatStash();
    expect(chatDraftSource.value).toBe('text');
  });
  it('does nothing without a stash', () => {
    chatDraft.value = '';
    expect(takeChatStash()).toBe(false);
    expect(chatDraft.value).toBe('');
  });
});
