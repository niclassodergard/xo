import { describe, expect, it, vi } from 'vitest';
import { RecorderError, startRecording } from './recorder.ts';
import type { RecorderEnv } from './recorder.ts';

class FakeTrack {
  stopped = false;
  listeners: (() => void)[] = [];
  get readyState() { return this.stopped ? 'ended' : 'live'; }
  stop() { this.stopped = true; }
  addEventListener(_t: string, fn: () => void) { this.listeners.push(fn); }
  end() { this.stopped = true; for (const l of this.listeners) l(); }
}
class FakeStream { tracks = [new FakeTrack(), new FakeTrack()]; getTracks() { return this.tracks; } }

class FakeRecorder {
  static last: FakeRecorder;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  stream: FakeStream;
  constructor(stream: FakeStream, opts?: { mimeType?: string }) {
    this.stream = stream;
    this.mimeType = opts?.mimeType ?? '';
    FakeRecorder.last = this;
  }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['abc'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function makeEnv(over: Partial<RecorderEnv> = {}) {
  const stream = new FakeStream();
  const timers: { fn: () => void; ms: number }[] = [];
  const env: RecorderEnv = {
    getUserMedia: async () => stream as unknown as MediaStream,
    MediaRecorder: FakeRecorder as unknown as RecorderEnv['MediaRecorder'],
    isTypeSupported: (t) => t === 'audio/webm;codecs=opus',
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
    clearTimeout: (id) => { timers[id as number] = { fn: () => {}, ms: -1 }; },
    ...over,
  };
  return { env, stream, timers };
}
const released = (s: FakeStream) => s.tracks.every((t) => t.stopped);

describe('startRecording', () => {
  it('records, returns audio with the recorder type and releases the microphone on stop', async () => {
    const { env, stream } = makeEnv();
    const rec = await startRecording({ maxMs: 1000, onMaxLength: () => {} }, env);
    expect(released(stream)).toBe(false);
    const blob = await rec.stop();
    expect(blob.type).toBe('audio/webm');
    expect(await blob.text()).toBe('abc');
    expect(released(stream)).toBe(true);
  });

  it('cancel releases the microphone, discards the audio and is idempotent', async () => {
    const { env, stream } = makeEnv();
    const rec = await startRecording({ maxMs: 1000, onMaxLength: () => {} }, env);
    rec.cancel();
    rec.cancel();
    expect(released(stream)).toBe(true);
    await expect(rec.stop()).rejects.toBeInstanceOf(RecorderError);
  });

  it('fires onMaxLength after maxMs, and not after stop', async () => {
    const { env, timers } = makeEnv();
    const onMax = vi.fn();
    const rec = await startRecording({ maxMs: 120_000, onMaxLength: onMax }, env);
    expect(timers[0]?.ms).toBe(120_000);
    timers[0]!.fn();
    expect(onMax).toHaveBeenCalledTimes(1);

    const second = makeEnv();
    const onMax2 = vi.fn();
    const rec2 = await startRecording({ maxMs: 5, onMaxLength: onMax2 }, second.env);
    await rec2.stop();
    second.timers[0]!.fn(); // cleared timer is a no-op replacement
    expect(onMax2).not.toHaveBeenCalled();
    rec.cancel();
  });

  it.each([
    ['NotAllowedError', 'denied'], ['SecurityError', 'denied'], ['NotFoundError', 'no_device'], ['NotReadableError', 'failed'],
  ])('maps getUserMedia %s to %s', async (name, code) => {
    const { env } = makeEnv({ getUserMedia: async () => { throw Object.assign(new Error('x'), { name }); } });
    await expect(startRecording({ maxMs: 1, onMaxLength: () => {} }, env)).rejects.toMatchObject({ code });
  });

  it('reports unsupported without MediaRecorder or getUserMedia', async () => {
    await expect(startRecording({ maxMs: 1, onMaxLength: () => {} }, makeEnv({ MediaRecorder: null }).env)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(startRecording({ maxMs: 1, onMaxLength: () => {} }, makeEnv({ getUserMedia: null }).env)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('releases the microphone when the recorder cannot be created or started', async () => {
    const stream = new FakeStream();
    class Throws { constructor() { throw new Error('bad'); } }
    const a = makeEnv({ getUserMedia: async () => stream as unknown as MediaStream, MediaRecorder: Throws as unknown as RecorderEnv['MediaRecorder'] });
    await expect(startRecording({ maxMs: 1, onMaxLength: () => {} }, a.env)).rejects.toMatchObject({ code: 'failed' });
    expect(released(stream)).toBe(true);

    const stream2 = new FakeStream();
    class NoStart extends FakeRecorder { override start(): void { throw new Error('bad'); } }
    const b = makeEnv({ getUserMedia: async () => stream2 as unknown as MediaStream, MediaRecorder: NoStart as unknown as RecorderEnv['MediaRecorder'] });
    await expect(startRecording({ maxMs: 1, onMaxLength: () => {} }, b.env)).rejects.toMatchObject({ code: 'failed' });
    expect(released(stream2)).toBe(true);
  });

  it('releases the microphone and rejects when the recorder never reports stop (watchdog)', async () => {
    const { env, stream, timers } = makeEnv();
    class Stuck extends FakeRecorder { override stop(): void { /* never fires stop */ } }
    env.MediaRecorder = Stuck as unknown as RecorderEnv['MediaRecorder'];
    const rec = await startRecording({ maxMs: 1000, onMaxLength: () => {} }, env);
    const p = rec.stop();
    expect(released(stream)).toBe(false);
    const wd = timers.find((t) => t.ms === 2000);
    expect(wd).toBeDefined();
    wd!.fn();
    await expect(p).rejects.toMatchObject({ code: 'interrupted' });
    expect(released(stream)).toBe(true);
  });

  it('reports a recorder error mid-recording through onError and releases the microphone', async () => {
    const { env, stream } = makeEnv();
    const onError = vi.fn();
    await startRecording({ maxMs: 1000, onMaxLength: () => {}, onError }, env);
    FakeRecorder.last.onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(released(stream)).toBe(true);
  });

  it('an unrequested stop (recorder stops by itself) reports onError and releases the microphone', async () => {
    const { env, stream } = makeEnv();
    const onError = vi.fn();
    await startRecording({ maxMs: 1000, onMaxLength: () => {}, onError }, env);
    FakeRecorder.last.state = 'inactive';
    FakeRecorder.last.onstop?.();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(released(stream)).toBe(true);
  });

  it('all tracks ending (microphone unplugged) reports onError once; one ending does not', async () => {
    const { env, stream } = makeEnv();
    const onError = vi.fn();
    await startRecording({ maxMs: 1000, onMaxLength: () => {}, onError }, env);
    stream.tracks[0]!.end();
    expect(onError).not.toHaveBeenCalled();
    stream.tracks[1]!.end();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(released(stream)).toBe(true);
  });

  it('a requested stop or cancel never reports onError', async () => {
    const a = makeEnv(); const onA = vi.fn();
    await (await startRecording({ maxMs: 1000, onMaxLength: () => {}, onError: onA }, a.env)).stop();
    const b = makeEnv(); const onB = vi.fn();
    (await startRecording({ maxMs: 1000, onMaxLength: () => {}, onError: onB }, b.env)).cancel();
    expect(onA).not.toHaveBeenCalled();
    expect(onB).not.toHaveBeenCalled();
  });

  it('a recorder error releases the microphone and fails a pending stop', async () => {
    const { env, stream } = makeEnv();
    class Stuck extends FakeRecorder { override stop(): void { /* never fires stop */ } }
    env.MediaRecorder = Stuck as unknown as RecorderEnv['MediaRecorder'];
    const rec = await startRecording({ maxMs: 1, onMaxLength: () => {} }, env);
    const p = rec.stop();
    FakeRecorder.last.onerror?.();
    await expect(p).rejects.toBeInstanceOf(RecorderError);
    expect(released(stream)).toBe(true);
  });
});
