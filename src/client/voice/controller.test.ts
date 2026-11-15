import { describe, expect, it, vi } from 'vitest';
import { createVoiceController } from './controller.ts';
import type { VoiceDeps } from './controller.ts';
import { RecorderError } from './recorder.ts';
import type { ActiveRecording } from './recorder.ts';

const people = [{ id: 1, name: 'Anna Berg', aliases: [] as string[] }];

function setup(over: Partial<VoiceDeps> = {}) {
  let t = 1000;
  let ep = 0;
  const rec = {
    stop: vi.fn(async () => new Blob(['audio'], { type: 'audio/webm' })),
    cancel: vi.fn(),
  } satisfies ActiveRecording;
  let onMax: () => void = () => {};
  let onErr: () => void = () => {};
  let overlay = false;
  const deps = {
    start: vi.fn(async (o: { onMaxLength: () => void; onError: () => void }) => { onMax = o.onMaxLength; onErr = o.onError; return rec; }),
    upload: vi.fn(async (_b: Blob, _s: AbortSignal): Promise<{ text: string }> => ({ text: 'hello world' })),
    people: () => people,
    overlayOpen: () => overlay,
    epoch: () => ep,
    now: () => t,
    flash: vi.fn(),
    runCommand: vi.fn(),
    dictate: vi.fn(),
    failureOf: (e: unknown) => (e as { api?: { status: number; code: string; retryAfter: number | null } })?.api ?? null,
    ...over,
  } satisfies VoiceDeps;
  const c = createVoiceController(deps);
  c.enable();
  return {
    c, deps, rec,
    advance: (ms: number) => { t += ms; },
    bumpEpoch: () => { ep++; },
    fireMax: () => onMax(),
    fireError: () => onErr(),
    setOverlay: (v: boolean) => { overlay = v; },
    phase: () => c.state.value.phase,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('voice controller', () => {
  it('records, uploads on release and dictates a plain transcript', async () => {
    const s = setup();
    s.c.press();
    expect(s.phase()).toBe('starting');
    await tick();
    expect(s.phase()).toBe('recording');
    s.advance(1500);
    s.c.release();
    expect(s.phase()).toBe('transcribing');
    await tick();
    expect(s.deps.upload).toHaveBeenCalledTimes(1);
    expect((vi.mocked(s.deps.upload).mock.calls[0]![0]).type).toBe('audio/webm');
    expect(s.deps.dictate).toHaveBeenCalledWith('hello world');
    expect(s.deps.runCommand).not.toHaveBeenCalled();
    expect(s.phase()).toBe('idle');
  });

  it('runs an open-project command using the projects dependency', async () => {
    const s = setup({
      upload: vi.fn(async () => ({ text: 'open Board deck' })),
      projects: () => [{ id: 7, title: 'Board deck', aliases: [] }],
    });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.runCommand).toHaveBeenCalledWith({ type: 'open_project', projectId: 7 });
    expect(s.deps.dictate).not.toHaveBeenCalled();
  });

  it('runs a matching voice command instead of dictating', async () => {
    const s = setup({ upload: vi.fn(async () => ({ text: 'Open Anna.' })) });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.runCommand).toHaveBeenCalledWith({ type: 'open_person', personId: 1 });
    expect(s.deps.dictate).not.toHaveBeenCalled();
  });

  it('tells the user when the command itself fails, unless the session ended', async () => {
    const s = setup({
      upload: vi.fn(async () => ({ text: 'go to notes' })),
      runCommand: vi.fn(async () => { throw new Error('boom'); }),
    });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.flash).toHaveBeenCalledWith('Could not run the voice command.', 'error');
  });

  it('discards a tap shorter than 300 ms without uploading and releases the mic', async () => {
    const s = setup();
    s.c.press(); await tick(); s.advance(100); s.c.release();
    expect(s.rec.cancel).toHaveBeenCalled();
    expect(s.rec.stop).not.toHaveBeenCalled();
    expect(s.deps.upload).not.toHaveBeenCalled();
    expect(s.phase()).toBe('idle');
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(/Too short/));
  });

  it('release before the microphone opened cancels the recording as soon as it opens', async () => {
    const s = setup();
    s.c.press(); s.c.release();
    expect(s.phase()).toBe('idle');
    await tick();
    expect(s.rec.cancel).toHaveBeenCalled();
    expect(s.phase()).toBe('idle');
    s.c.press(); await tick();
    expect(s.phase()).toBe('recording'); // a new press after that works normally
  });

  it('Esc/cancel while recording discards the audio', async () => {
    const s = setup();
    s.c.press(); await tick(); s.advance(2000);
    s.c.cancel();
    expect(s.rec.cancel).toHaveBeenCalled();
    s.c.release(); await tick();
    expect(s.deps.upload).not.toHaveBeenCalled();
    expect(s.phase()).toBe('idle');
  });

  it('at the maximum length a key-held recording without proof of the hold goes to the prompt, nothing is sent', async () => {
    for (const heldAlive of [undefined, () => false]) {
      const s = setup(heldAlive ? { heldAlive } : {});
      s.c.press({ held: true }); await tick(); s.advance(120_000);
      s.fireMax(); await tick();
      expect(s.phase()).toBe('confirming');
      expect(s.deps.upload).not.toHaveBeenCalled();
      s.c.cancel();
    }
  });

  it('stops and uploads at the maximum length only while the key is provably held', async () => {
    const s = setup({ heldAlive: () => true });
    s.c.press({ held: true }); await tick(); s.advance(120_000);
    s.fireMax(); await tick();
    expect(s.deps.upload).toHaveBeenCalledTimes(1);
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(/120 s/));
  });

  it('flashes recorder failures: permission, unsupported, no device', async () => {
    for (const [code, re] of [['denied', /denied/], ['unsupported', /not supported/], ['no_device', /No microphone/]] as const) {
      const s = setup({ start: vi.fn(async () => { throw new RecorderError(code); }) });
      s.c.press(); await tick();
      expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(re), 'error');
      expect(s.phase()).toBe('idle');
    }
  });

  it.each([
    [413, 'http_error', null, /too large/], [415, 'http_error', null, /format/],
    [429, 'rate_limited', 9, /Too many.*9 s/], [429, 'busy', 5, /busy/],
    [502, 'http_error', null, /provider/], [503, 'http_error', null, /not available/],
  ])('maps upload failure %i/%s to a status message and returns to idle', async (status, code, retryAfter, re) => {
    const s = setup({ upload: vi.fn(async () => { throw { api: { status, code, retryAfter } }; }) });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(re), 'error');
    expect(s.deps.dictate).not.toHaveBeenCalled();
    expect(s.phase()).toBe('idle');
  });

  it('says so on an empty transcript and does nothing else', async () => {
    const s = setup({ upload: vi.fn(async () => ({ text: '  ' })) });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(/Didn't catch/));
    expect(s.deps.dictate).not.toHaveBeenCalled();
    expect(s.deps.runCommand).not.toHaveBeenCalled();
  });

  it('rejects an audio type the server would 415 without uploading', async () => {
    const s = setup();
    s.rec.stop.mockResolvedValueOnce(new Blob(['x'], { type: 'audio/x-weird' }));
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.upload).not.toHaveBeenCalled();
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(/format/), 'error');
  });

  it('drops the result silently when the session ended during the upload', async () => {
    let resolve!: (v: { text: string }) => void;
    const s = setup({ upload: vi.fn(() => new Promise<{ text: string }>((r) => { resolve = r; })) });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    s.bumpEpoch();
    resolve({ text: 'secret dictation' });
    await tick();
    expect(s.deps.dictate).not.toHaveBeenCalled();
    expect(s.deps.runCommand).not.toHaveBeenCalled();
    expect(s.deps.flash).not.toHaveBeenCalled();
  });

  it('dispose cancels an active recording and ignores a late upload result', async () => {
    const s = setup();
    s.c.press(); await tick();
    s.c.dispose();
    expect(s.rec.cancel).toHaveBeenCalled();
    expect(s.phase()).toBe('idle');

    const s2 = setup();
    s2.c.press(); await tick(); s2.advance(1000); s2.c.release();
    s2.c.dispose(); await tick();
    expect(s2.deps.dictate).not.toHaveBeenCalled();
  });

  it('pressing while transcribing does not start a second recording', async () => {
    let resolve!: (v: { text: string }) => void;
    const s = setup({ upload: vi.fn(() => new Promise<{ text: string }>((r) => { resolve = r; })) });
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    s.c.press();
    expect(s.deps.start).toHaveBeenCalledTimes(1);
    expect(s.phase()).toBe('transcribing');
    resolve({ text: 'x' }); await tick();
  });

  it('toggle starts, then stops and transcribes', async () => {
    const s = setup();
    s.c.toggle(); await tick(); s.advance(1000);
    s.c.toggle(); await tick();
    expect(s.deps.dictate).toHaveBeenCalledWith('hello world');
  });
});

describe('voice controller: teardown and safety', () => {
  describe('toggle-started recording at the maximum length', () => {
    async function atLimit() {
      const s = setup();
      s.c.toggle(); await tick(); s.advance(120_000);
      s.fireMax(); await tick();
      return s;
    }
    it('stops, keeps the audio and waits for a choice without sending anything', async () => {
      const s = await atLimit();
      expect(s.rec.stop).toHaveBeenCalledTimes(1);
      expect(s.rec.cancel).not.toHaveBeenCalled();
      expect(s.phase()).toBe('confirming');
      expect(s.deps.upload).not.toHaveBeenCalled();
      s.c.toggle(); s.c.press(); s.c.release(); await tick(); // nothing but Send/Discard acts on it
      expect(s.phase()).toBe('confirming');
      expect(s.deps.upload).not.toHaveBeenCalled();
    });
    it('Send uploads the kept audio and dictates', async () => {
      const s = await atLimit();
      s.c.send(); await tick();
      expect(s.deps.upload).toHaveBeenCalledTimes(1);
      expect(s.deps.dictate).toHaveBeenCalledWith('hello world');
      expect(s.phase()).toBe('idle');
    });
    it('Discard drops it without uploading', async () => {
      const s = await atLimit();
      s.c.cancel(); await tick();
      expect(s.phase()).toBe('idle');
      s.c.send(); await tick();
      expect(s.deps.upload).not.toHaveBeenCalled();
      expect(s.deps.flash).toHaveBeenCalledWith('Recording discarded.');
    });
    it('dispose (session end, teardown) discards it', async () => {
      const s = await atLimit();
      s.c.dispose();
      expect(s.phase()).toBe('idle');
      s.c.send(); await tick();
      expect(s.deps.upload).not.toHaveBeenCalled();
    });
    it('is discarded after 60 s without a choice, and a later Send does nothing', async () => {
      vi.useFakeTimers();
      try {
        const s = setup();
        s.c.toggle(); await vi.advanceTimersByTimeAsync(0); s.advance(120_000);
        s.fireMax(); await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(s.phase()).toBe('confirming');
        await vi.advanceTimersByTimeAsync(1_500);
        expect(s.phase()).toBe('idle');
        expect(s.deps.flash).toHaveBeenCalledWith('Recording discarded: no choice was made.', 'error');
        s.c.send(); await vi.advanceTimersByTimeAsync(0);
        expect(s.deps.upload).not.toHaveBeenCalled();
      } finally { vi.useRealTimers(); }
    });
    it('a Send before the timeout cancels the timer', async () => {
      vi.useFakeTimers();
      try {
        const s = setup();
        s.c.toggle(); await vi.advanceTimersByTimeAsync(0); s.advance(120_000);
        s.fireMax(); await vi.advanceTimersByTimeAsync(0);
        s.c.send();
        await vi.advanceTimersByTimeAsync(70_000);
        expect(s.deps.upload).toHaveBeenCalledTimes(1);
        expect(s.deps.flash).not.toHaveBeenCalledWith('Recording discarded: no choice was made.', 'error');
      } finally { vi.useRealTimers(); }
    });
    it('a recorder that fails to deliver the audio leaves the choice with a message', async () => {
      const s = setup();
      s.rec.stop.mockRejectedValueOnce(new RecorderError('interrupted'));
      s.c.toggle(); await tick(); s.advance(120_000);
      s.fireMax(); await tick();
      expect(s.phase()).toBe('idle');
      expect(s.deps.flash).toHaveBeenCalledWith('Recording stopped unexpectedly.', 'error');
    });
  });

  it('press and toggle are no-ops until enabled and after dispose', async () => {
    const deps = setup().deps;
    const c = createVoiceController(deps);
    c.press(); c.toggle();
    await tick();
    expect(c.state.value.phase).toBe('idle');
    expect(deps.start).not.toHaveBeenCalled();
    c.enable(); c.press(); await tick();
    expect(c.state.value.phase).toBe('recording');
    c.dispose();
    c.press(); c.toggle(); await tick();
    expect(c.state.value.phase).toBe('idle');
    expect(deps.start).toHaveBeenCalledTimes(1);
  });

  it('aborts the upload on cancel and on dispose, and Esc-cancel works while transcribing', async () => {
    for (const how of ['cancel', 'dispose'] as const) {
      let sig!: AbortSignal;
      const s = setup({ upload: vi.fn((_b: Blob, signal: AbortSignal) => { sig = signal; return new Promise<{ text: string }>(() => {}); }) });
      s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
      expect(s.phase()).toBe('transcribing');
      expect(sig.aborted).toBe(false);
      s.c[how]();
      expect(sig.aborted).toBe(true);
      expect(s.phase()).toBe('idle');
    }
  });

  it('aborts and reports a timeout when the upload hangs', async () => {
    vi.useFakeTimers();
    try {
      let sig!: AbortSignal;
      const s = setup({
        upload: vi.fn((_b: Blob, signal: AbortSignal) => new Promise<{ text: string }>((_r, rej) => {
          sig = signal;
          signal.addEventListener('abort', () => rej(new Error('aborted')));
        })),
      });
      s.c.press(); await vi.advanceTimersByTimeAsync(0); s.advance(1000); s.c.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.phase()).toBe('transcribing');
      await vi.advanceTimersByTimeAsync(100_001);
      expect(sig.aborted).toBe(true);
      expect(s.phase()).toBe('idle');
      expect(s.deps.flash).toHaveBeenCalledWith('Transcription timed out.', 'error');
    } finally { vi.useRealTimers(); }
  });

  it('a recorder error mid-recording leaves REC at once with a message', async () => {
    const s = setup();
    s.c.press(); await tick();
    s.fireError();
    expect(s.phase()).toBe('idle');
    expect(s.deps.flash).toHaveBeenCalledWith('Recording stopped unexpectedly.', 'error');
    s.advance(1000); s.c.release(); await tick();
    expect(s.deps.upload).not.toHaveBeenCalled();
  });

  it('release before the mic opened says the microphone was not ready', async () => {
    const s = setup();
    s.c.press(); s.c.release();
    expect(s.deps.flash).toHaveBeenCalledWith(expect.stringMatching(/wasn't ready.*REC/));
  });

  it('with an overlay open a command is kept as dictation and nothing runs', async () => {
    const s = setup({ upload: vi.fn(async () => ({ text: 'Open Anna.' })) });
    s.setOverlay(true);
    s.c.press(); await tick(); s.advance(1000); s.c.release(); await tick();
    expect(s.deps.runCommand).not.toHaveBeenCalled();
    expect(s.deps.dictate).toHaveBeenCalledWith('Open Anna.');
  });
});
