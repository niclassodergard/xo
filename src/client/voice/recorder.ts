import { AUDIO_BITS_PER_SECOND, STOP_WATCHDOG_MS, pickMime, uploadContentType } from './voice-logic.ts';

// MediaRecorder wrapper. The microphone is held only between start and stop/cancel: every path
// (stop, cancel, error, failed start) stops all tracks. Chunks live in memory only and are dropped
// as soon as the Blob is handed over.

export type RecorderErrorCode = 'unsupported' | 'denied' | 'no_device' | 'failed' | 'interrupted';
export class RecorderError extends Error {
  code: RecorderErrorCode;
  constructor(code: RecorderErrorCode) {
    super(code);
    this.name = 'RecorderError';
    this.code = code;
  }
}

export interface ActiveRecording {
  /** Stops recording, releases the microphone and resolves with the audio. Rejects with RecorderError. */
  stop(): Promise<Blob>;
  /** Stops recording and releases the microphone, discarding the audio. Safe to call repeatedly. */
  cancel(): void;
}

/** The slice of the browser the recorder needs; injectable for tests. */
export interface RecorderEnv {
  getUserMedia: ((c: MediaStreamConstraints) => Promise<MediaStream>) | null;
  MediaRecorder: (new (stream: MediaStream, opts?: MediaRecorderOptions) => MediaRecorder) | null;
  isTypeSupported: (type: string) => boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export function browserEnv(): RecorderEnv {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  const MR = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  return {
    getUserMedia: md && typeof md.getUserMedia === 'function' ? (c) => md.getUserMedia(c) : null,
    MediaRecorder: MR,
    isTypeSupported: (t) => (MR && typeof MR.isTypeSupported === 'function' ? MR.isTypeSupported(t) : false),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
}

function releaseStream(stream: MediaStream): void {
  for (const t of stream.getTracks()) {
    try { t.stop(); } catch { /* already stopped */ }
  }
}

function mapMediaError(e: unknown): RecorderError {
  const name = e instanceof Error ? e.name : (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return new RecorderError('denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return new RecorderError('no_device');
  return new RecorderError('failed');
}

/**
 * Open the microphone and start recording. `onMaxLength` fires once after `maxMs`; the caller decides
 * whether to stop (upload) or cancel. Rejects with RecorderError.
 */
export async function startRecording(
  opts: { maxMs: number; onMaxLength: () => void; onError?: () => void },
  env: RecorderEnv = browserEnv(),
): Promise<ActiveRecording> {
  if (!env.getUserMedia || !env.MediaRecorder) throw new RecorderError('unsupported');
  let stream: MediaStream;
  try {
    stream = await env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    throw mapMediaError(e);
  }

  let rec: MediaRecorder;
  try {
    const mime = pickMime(env.isTypeSupported);
    rec = new env.MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
  } catch {
    releaseStream(stream);
    throw new RecorderError('failed');
  }

  let chunks: Blob[] = [];
  let finished = false;
  let timer: unknown = null;
  let watchdog: unknown = null;
  let settle: { resolve: (b: Blob) => void; reject: (e: RecorderError) => void } | null = null;

  const finish = (): void => {
    finished = true;
    if (timer !== null) { env.clearTimeout(timer); timer = null; }
    if (watchdog !== null) { env.clearTimeout(watchdog); watchdog = null; }
    releaseStream(stream);
  };

  rec.ondataavailable = (ev: BlobEvent) => {
    if (!finished && ev.data && ev.data.size > 0) chunks.push(ev.data);
  };
  rec.onstop = () => {
    const parts = chunks;
    chunks = [];
    const type = uploadContentType(rec.mimeType || parts[0]?.type || '') ?? (rec.mimeType || parts[0]?.type || '');
    const s = settle;
    settle = null;
    const wasFinished = finished;
    finish();
    if (s && !wasFinished) s.resolve(new Blob(parts, { type }));
    else if (s) s.reject(new RecorderError('interrupted'));
    else if (!wasFinished) opts.onError?.(); // stopped on its own (e.g. all tracks ended): leave REC
  };
  rec.onerror = () => {
    chunks = [];
    const s = settle;
    settle = null;
    const active = rec.state !== 'inactive';
    const wasFinished = finished;
    finish();
    if (active) { try { rec.stop(); } catch { /* ignore */ } }
    if (s) s.reject(new RecorderError('interrupted'));
    else if (!wasFinished) opts.onError?.(); // died mid-recording: tell the owner so the UI leaves REC
  };

  // Microphone unplugged / permission revoked: every track ends. Treat it like an unrequested stop.
  const onTrackEnded = (): void => {
    if (finished || settle) return;
    if (!stream.getTracks().every((t) => t.readyState === 'ended')) return;
    chunks = [];
    const active = rec.state !== 'inactive';
    finish();
    if (active) { try { rec.stop(); } catch { /* ignore */ } }
    opts.onError?.();
  };
  for (const t of stream.getTracks()) t.addEventListener?.('ended', onTrackEnded);

  try {
    rec.start();
  } catch {
    finish();
    throw new RecorderError('failed');
  }
  timer = env.setTimeout(() => {
    timer = null;
    if (!finished) opts.onMaxLength();
  }, opts.maxMs);

  return {
    stop() {
      return new Promise<Blob>((resolve, reject) => {
        if (finished) { reject(new RecorderError('interrupted')); return; }
        settle = { resolve, reject };
        if (timer !== null) { env.clearTimeout(timer); timer = null; }
        if (rec.state === 'inactive') { rec.onstop?.(new Event('stop')); return; }
        // If the recorder never reports `stop`, do not hold the microphone (or the caller) forever.
        watchdog = env.setTimeout(() => {
          watchdog = null;
          const s = settle;
          settle = null;
          if (!s) return;
          chunks = [];
          finish();
          s.reject(new RecorderError('interrupted'));
        }, STOP_WATCHDOG_MS);
        try { rec.stop(); } catch { finish(); settle = null; reject(new RecorderError('interrupted')); }
      });
    },
    cancel() {
      if (finished) return;
      chunks = [];
      const s = settle;
      settle = null;
      finish();
      if (rec.state !== 'inactive') { try { rec.stop(); } catch { /* ignore */ } }
      s?.reject(new RecorderError('interrupted'));
    },
  };
}
