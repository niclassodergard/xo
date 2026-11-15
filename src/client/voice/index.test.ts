import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Key wiring of initVoice(), driven through the real key engine and key-listener installer with a
// fake window/document. The recorder and the upload are faked; nothing touches the network.
const rec = { stop: vi.fn(), cancel: vi.fn() };
vi.mock('./recorder.ts', async (orig) => ({
  ...(await orig<typeof import('./recorder.ts')>()),
  startRecording: vi.fn(async () => rec),
}));

class El {}
class FakeWindow extends EventTarget {
  document = Object.assign(new EventTarget(), { activeElement: null as unknown, visibilityState: 'visible' });
}

const { initVoice } = await import('./index.ts');
const { startRecording } = await import('./recorder.ts');
const { api } = await import('../lib/api.ts');
const { engine, installKeyListeners, registerCommand: _r } = await import('../lib/keys.ts');
const { flash: _f, session, chatDraft, chatDraftSource, flashMessage } = await import('../lib/store.ts');
void _r; void _f;

let win: FakeWindow;
let uninstall: () => void;
let cleanup: () => void;
let globalEsc: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;
let removeGlobalEsc: () => void;

function key(type: 'keydown' | 'keyup', init: { key: string; code: string; altKey?: boolean; metaKey?: boolean; repeat?: boolean }): Event {
  const ev = Object.assign(new Event(type, { cancelable: true }), { altKey: false, metaKey: false, repeat: false, ...init });
  win.dispatchEvent(ev);
  return ev;
}
const SPACE = { key: ' ', code: 'Space' };
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
const phaseText = () => flashMessage.value?.message ?? '';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  Object.assign(globalThis, { HTMLElement: El, HTMLInputElement: El, HTMLTextAreaElement: El, HTMLSelectElement: El });
  win = new FakeWindow();
  Object.assign(globalThis, { window: win, document: win.document });
  session.value = { csrfToken: 't' };
  chatDraft.value = '';
  rec.stop.mockReset().mockResolvedValue(new Blob(['a'], { type: 'audio/webm' }));
  rec.cancel.mockReset();
  vi.mocked(startRecording).mockClear();
  vi.spyOn(api, 'postAudio').mockResolvedValue({ text: 'hello' });
  uninstall = installKeyListeners(win as unknown as Window);
  globalEsc = vi.fn<(e: KeyboardEvent) => void>();
  removeGlobalEsc = engine.addLayer({ scope: 'global', bindings: [{ spec: 'esc', run: globalEsc }] });
  cleanup = initVoice();
});
afterEach(() => {
  cleanup();
  removeGlobalEsc();
  uninstall();
  vi.restoreAllMocks();
  vi.useRealTimers();
  session.value = null;
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
});

describe('initVoice key wiring', () => {
  it('starts on the first Space keydown only (auto-repeat ignored) and uploads on keyup', async () => {
    key('keydown', SPACE);
    key('keydown', { ...SPACE, repeat: true });
    key('keydown', { ...SPACE, repeat: true });
    await flush();
    expect(startRecording).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE);
    await flush();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(api.postAudio).toHaveBeenCalledTimes(1);
    expect(chatDraft.value).toBe('hello');
    expect(chatDraftSource.value).toBe('voice');
  });

  it('Space does nothing while a text field has focus, Option-Space works anywhere', async () => {
    win.document.activeElement = Object.assign(new El(), { type: 'text' }); // focus in a text input
    key('keydown', SPACE);
    await flush();
    expect(startRecording).not.toHaveBeenCalled();
    key('keydown', { ...SPACE, altKey: true });
    await flush();
    expect(startRecording).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE); // releasing Space ends an Alt+Space recording
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);
  });

  it('a keyup that does not belong to a hold (other key, or no hold) does nothing', async () => {
    key('keyup', SPACE);
    await flush();
    expect(rec.stop).not.toHaveBeenCalled();
    key('keydown', SPACE); await flush();
    key('keyup', { key: 'a', code: 'KeyA' });
    await flush();
    expect(rec.stop).not.toHaveBeenCalled();
    expect(rec.cancel).not.toHaveBeenCalled();
    key('keyup', SPACE); // too short: discarded
    await flush();
    expect(rec.cancel).toHaveBeenCalled();
  });

  it('Esc while recording cancels and the global Esc handler does not run', async () => {
    key('keydown', SPACE); await flush();
    const ev = key('keydown', { key: 'Escape', code: 'Escape' });
    await flush();
    expect(rec.cancel).toHaveBeenCalled();
    expect(globalEsc).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE); await flush();
    expect(api.postAudio).not.toHaveBeenCalled();
    // Idle again: Esc reaches the global handler.
    key('keydown', { key: 'Escape', code: 'Escape' });
    expect(globalEsc).toHaveBeenCalledTimes(1);
  });

  it('Esc while transcribing aborts the upload', async () => {
    let sig!: AbortSignal;
    vi.mocked(api.postAudio).mockImplementation((_p, _b, s) => { sig = s!; return new Promise(() => {}); });
    key('keydown', SPACE); await flush();
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE); await flush();
    expect(sig.aborted).toBe(false);
    key('keydown', { key: 'Escape', code: 'Escape' });
    expect(sig.aborted).toBe(true);
    expect(globalEsc).not.toHaveBeenCalled();
  });

  it('Space stops a recording that the palette command started', async () => {
    const { commandList } = await import('../lib/keys.ts');
    commandList.value.find((c) => c.id === 'voice.dictate')!.run();
    await flush();
    vi.setSystemTime(Date.now() + 1000);
    key('keydown', SPACE);
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);
  });

  it('window blur, a hidden tab and pagehide discard the recording', async () => {
    for (const trigger of [
      () => win.dispatchEvent(new Event('blur')),
      () => { win.document.visibilityState = 'hidden'; win.document.dispatchEvent(new Event('visibilitychange')); },
      () => win.dispatchEvent(new Event('pagehide')),
    ]) {
      rec.cancel.mockClear();
      key('keydown', SPACE); await flush();
      trigger();
      expect(rec.cancel).toHaveBeenCalledTimes(1);
      key('keyup', SPACE); await flush();
      win.document.visibilityState = 'visible';
    }
    expect(api.postAudio).not.toHaveBeenCalled();
  });

  it('toggle recording at the limit: Enter sends, Esc discards, hidden tab discards, nothing is sent on its own', async () => {
    const { commandList } = await import('../lib/keys.ts');
    const maxCall = () => vi.mocked(startRecording).mock.calls.at(-1)![0].onMaxLength;
    const toLimit = async () => {
      commandList.value.find((c) => c.id === 'voice.dictate')!.run();
      await flush();
      vi.setSystemTime(Date.now() + 120_000);
      maxCall()();
      await flush();
    };
    await toLimit();
    expect(rec.stop).toHaveBeenCalledTimes(1);
    expect(api.postAudio).not.toHaveBeenCalled();
    key('keydown', { key: 'Enter', code: 'Enter' });
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);

    await toLimit();
    key('keydown', { key: 'Escape', code: 'Escape' });
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);
    expect(globalEsc).not.toHaveBeenCalled();

    await toLimit();
    win.document.visibilityState = 'hidden';
    win.document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    key('keydown', { key: 'Enter', code: 'Enter' });
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);
    win.document.visibilityState = 'visible';

    await toLimit();
    win.dispatchEvent(new Event('blur'));
    await toLimit();
    session.value = null;
    key('keydown', { key: 'Enter', code: 'Enter' });
    await flush();
    expect(api.postAudio).toHaveBeenCalledTimes(1);
  });

  it('a session that ends tears voice down at once and a later Space does nothing', async () => {
    key('keydown', SPACE); await flush();
    session.value = null;
    expect(rec.cancel).toHaveBeenCalled();
    vi.mocked(startRecording).mockClear();
    key('keydown', SPACE); await flush();
    expect(startRecording).not.toHaveBeenCalled();
  });

  it('cleanup removes the bindings, listeners and the palette command, and releases the recording', async () => {
    const { commandList } = await import('../lib/keys.ts');
    key('keydown', SPACE); await flush();
    cleanup();
    expect(rec.cancel).toHaveBeenCalled();
    expect(commandList.value.some((c) => c.id === 'voice.dictate')).toBe(false);
    vi.mocked(startRecording).mockClear();
    key('keydown', SPACE); await flush();
    key('keydown', { ...SPACE, altKey: true }); await flush();
    expect(startRecording).not.toHaveBeenCalled();
    win.dispatchEvent(new Event('blur')); // no listener left: must not throw
    cleanup = () => {}; // afterEach
  });

  it('dictation is flashed, not navigated, while an overlay is open', async () => {
    const { overlay } = await import('../lib/store.ts');
    overlay.value = 'help';
    key('keydown', { ...SPACE, altKey: true }); await flush();
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE); await flush();
    expect(chatDraft.value).toBe('hello');
    expect(phaseText()).toBe('Dictation added to chat');
    overlay.value = null;
  });

  describe('Send/Discard prompt and Enter', () => {
    const maxCall = () => vi.mocked(startRecording).mock.calls.at(-1)![0].onMaxLength;
    const field = () => {
      const f = Object.assign(new El(), { blur: vi.fn(() => { win.document.activeElement = null; }), focus: vi.fn(), isConnected: true });
      win.document.activeElement = f;
      return f;
    };
    const startToggle = async () => {
      const { commandList } = await import('../lib/keys.ts');
      commandList.value.find((c) => c.id === 'voice.dictate')!.run();
      await flush();
      vi.setSystemTime(Date.now() + 120_000);
    };

    it('not typing: the field is blurred at once and Enter sends the recording, not the draft', async () => {
      const f = field();
      await startToggle();
      maxCall()(); await flush();
      expect(f.blur).toHaveBeenCalled();
      key('keydown', { key: 'Enter', code: 'Enter' }); await flush();
      expect(api.postAudio).toHaveBeenCalledTimes(1);
    });

    it('a focused button or link is blurred too, so Enter cannot click it', async () => {
      const b = Object.assign(new El(), { tagName: 'BUTTON', blur: vi.fn(() => { win.document.activeElement = null; }), isConnected: true });
      win.document.activeElement = b;
      await startToggle();
      maxCall()(); await flush();
      expect(b.blur).toHaveBeenCalled();
      key('keydown', { key: 'Enter', code: 'Enter' }); await flush();
      expect(api.postAudio).toHaveBeenCalledTimes(1);
    });

    it('typing when the prompt appears: the field keeps focus and Enter is not armed until typing stops', async () => {
      const f = field();
      await startToggle();
      key('keydown', { key: 'a', code: 'KeyA' });
      maxCall()(); await flush();
      expect(f.blur).not.toHaveBeenCalled();
      key('keydown', { key: 'a', code: 'KeyA' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.blur).not.toHaveBeenCalled();
      win.document.activeElement = null; // as if focus were elsewhere: Enter still must not send yet
      key('keydown', { key: 'Enter', code: 'Enter' }); await flush();
      expect(api.postAudio).not.toHaveBeenCalled();
      win.document.activeElement = f;
      await vi.advanceTimersByTimeAsync(1000); // 2 s after the last keystroke
      expect(f.blur).toHaveBeenCalled();
      win.document.activeElement = null;
      key('keydown', { key: 'Enter', code: 'Enter' }); await flush();
      expect(api.postAudio).toHaveBeenCalledTimes(1);
    });
  });

  describe('held key at the limit', () => {
    const maxCall = () => vi.mocked(startRecording).mock.calls.at(-1)![0].onMaxLength;

    it('sends only with a recent auto-repeat keydown for the held key', async () => {
      key('keydown', SPACE); await flush();
      vi.setSystemTime(Date.now() + 119_500);
      key('keydown', { ...SPACE, repeat: true });
      vi.setSystemTime(Date.now() + 500);
      maxCall()(); await flush();
      expect(api.postAudio).toHaveBeenCalledTimes(1);
    });

    it('without auto-repeat proof (lost keyup) it shows the prompt and sends nothing', async () => {
      key('keydown', SPACE); await flush();
      vi.setSystemTime(Date.now() + 120_000);
      maxCall()(); await flush();
      expect(api.postAudio).not.toHaveBeenCalled();
      expect(rec.stop).toHaveBeenCalledTimes(1); // stopped, audio held for Send/Discard
    });

    it('a keydown with Cmd during the hold ends the hold: no auto-send even with repeats', async () => {
      key('keydown', SPACE); await flush();
      key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
      key('keydown', { ...SPACE, repeat: true, metaKey: true });
      vi.setSystemTime(Date.now() + 120_000);
      maxCall()(); await flush();
      expect(api.postAudio).not.toHaveBeenCalled();
    });
  });

  it('dictation never navigates or moves focus when the user typed during the transcription', async () => {
    let resolve: (v: { text: string }) => void = () => {};
    vi.spyOn(api, 'postAudio').mockReturnValue(new Promise((r) => { resolve = r; }));
    key('keydown', SPACE); await flush();
    vi.setSystemTime(Date.now() + 1000);
    key('keyup', SPACE); await flush();
    key('keydown', { key: 'x', code: 'KeyX' }); // typed while the audio is being transcribed
    resolve({ text: 'hello' }); await flush();
    expect(chatDraft.value).toBe('hello');
    expect(phaseText()).toBe('Dictation added to chat');
  });
});
