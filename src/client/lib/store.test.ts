import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appPhase, chatDraft, clearDraft, drafts, epoch, flashMessage, logout, overlay, people, personPicker, promptRequest,
  refreshPeople, searchQuery, session, setDraft, shellActive, syncDraft, togglePalette,
} from './store.ts';
import { mode } from './keys.ts';
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
  afterEach(() => { overlay.value = null; personPicker.value = null; promptRequest.value = null; mode.value = 'normal'; });

  it('Ctrl-K / ":" is a no-op while a Prompt or person picker is open', () => {
    promptRequest.value = { label: 'New person', onSubmit: () => {} };
    togglePalette();
    expect(overlay.value).toBeNull();
    expect(mode.value).toBe('normal');
    promptRequest.value = null;
    personPicker.value = { onPick: () => {} };
    togglePalette();
    expect(overlay.value).toBeNull();
    personPicker.value = null;
    togglePalette();
    expect(overlay.value).toBe('palette');
    expect(mode.value).toBe('command');
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

