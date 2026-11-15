import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.ts';
import { startMeeting } from './commands.ts';
import { registerFocusTarget, resetFocusTargets } from './focus.ts';
import { installKeyListeners, keystrokeMark } from './keys.ts';
import { route } from './router.ts';
import { session } from './store.ts';

class FakeWindow extends EventTarget {
  document = Object.assign(new EventTarget(), { activeElement: null as unknown });
}

afterEach(() => { vi.restoreAllMocks(); session.value = null; resetFocusTargets(); });

describe('async commands and focus', () => {
  async function run(typeDuringRequest: boolean, markOverride?: number): Promise<ReturnType<typeof vi.fn>> {
    session.value = { csrfToken: 't' };
    const focus = vi.fn();
    registerFocusTarget('panel', () => ({ focus, isConnected: true } as unknown as HTMLElement));
    const win = new FakeWindow();
    const off = installKeyListeners(win as unknown as Window);
    let release!: (v: unknown) => void;
    vi.spyOn(api, 'post').mockImplementation(() => new Promise((r) => { release = r; }));
    const pending = markOverride === undefined ? startMeeting(5) : startMeeting(5, markOverride);
    if (typeDuringRequest) win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'a' }));
    release({ meeting: { id: 9 } });
    await pending;
    off();
    return focus;
  }

  it('opens the document and focuses the panel when the user did not type', async () => {
    const focus = await run(false);
    expect(route.value).toEqual({ name: 'meeting', params: { id: '9' } });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('opens the document but leaves focus alone when the user typed meanwhile', async () => {
    const focus = await run(true);
    expect(route.value).toEqual({ name: 'meeting', params: { id: '9' } });
    expect(focus).not.toHaveBeenCalled();
  });

  it('uses a mark passed by the caller: typing since that earlier mark keeps focus away', async () => {
    const focus = await run(false, keystrokeMark() - 1); // a mark older than the keystrokes seen so far counts as typed since
    expect(focus).not.toHaveBeenCalled();
  });

  it('does nothing when the session ended during the request', async () => {
    session.value = { csrfToken: 't' };
    route.value = { name: 'home', params: {} };
    let release!: (v: unknown) => void;
    vi.spyOn(api, 'post').mockImplementation(() => new Promise((r) => { release = r; }));
    const pending = startMeeting(5);
    session.value = null;
    release({ meeting: { id: 9 } });
    await pending;
    expect(route.value.name).toBe('home');
  });
});
