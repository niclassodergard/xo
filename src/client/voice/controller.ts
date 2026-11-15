import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { PersonLike } from '../../shared/people-match.ts';
import type { VoiceCommand } from '../../shared/types.ts';
import { RecorderError } from './recorder.ts';
import type { ActiveRecording } from './recorder.ts';
import {
  BAD_FORMAT_MESSAGE, EMPTY_TRANSCRIPT_MESSAGE, INTERRUPTED_MESSAGE, MAX_LENGTH_MESSAGE, MAX_RECORDING_MS,
  NOT_READY_MESSAGE, CHOICE_TIMEOUT_MS, DISCARDED_MESSAGE, NO_CHOICE_MESSAGE, TIMEOUT_MESSAGE, TOO_SHORT_MESSAGE, UPLOAD_TIMEOUT_MS,
  decideTranscript, isTooShort, nextPhase, recorderErrorMessage, transcribeFailureMessage, uploadContentType,
} from './voice-logic.ts';
import type { FailureLike, VoicePhase } from './voice-logic.ts';

// The voice flow, with every browser/store dependency injected so it can be tested without a DOM.
// Audio is held only in local variables of `finish()`; nothing is stored, logged or kept after upload.

export interface VoiceState { phase: VoicePhase; startedAt: number | null }

export interface VoiceDeps {
  start(opts: { maxMs: number; onMaxLength: () => void; onError: () => void }): Promise<ActiveRecording>;
  upload(blob: Blob, signal: AbortSignal): Promise<{ text: string }>;
  people(): PersonLike[];
  epoch(): number;
  now(): number;
  flash(message: string, kind?: 'info' | 'error'): void;
  runCommand(command: VoiceCommand): Promise<void> | void;
  dictate(text: string): void;
  /** True while an overlay, person picker or prompt owns the keyboard: nothing may navigate then. */
  overlayOpen(): boolean;
  /** Reduce a thrown upload error to the fields the message needs; null = not an API error. */
  failureOf(e: unknown): FailureLike | null;
}

export interface VoiceController {
  state: Signal<VoiceState>;
  /** Voice is live only between enable() and dispose(); press/toggle do nothing otherwise. */
  enable(): void;
  /** Start recording (ignored unless idle). `held`: a key is physically held (key-started recording). */
  press(opts?: { held?: boolean }): void;
  /** Send the audio of a recording that reached the maximum length (phase 'confirming'). */
  send(): void;
  /** End the recording and transcribe it (or discard it when too short / released before it began). */
  release(): void;
  /** Throw the recording (or an upload in flight) away without a result. */
  cancel(): void;
  /** Mic button: start when idle, finish when recording. */
  toggle(): void;
  /** Session ended or voice torn down: cancel everything, abort uploads, ignore late results. */
  dispose(): void;
}

export function createVoiceController(deps: VoiceDeps): VoiceController {
  const state: Signal<VoiceState> = signal<VoiceState>({ phase: 'idle', startedAt: null });
  let enabled = false;
  let gen = 0; // advances on cancel/dispose: late async results from an older run are dropped
  let rec: ActiveRecording | null = null;
  let held = false;
  let abort: AbortController | null = null;
  let heldAudio: Promise<Blob> | null = null; // audio of a recording awaiting Send/Discard
  let choiceTimer: ReturnType<typeof setTimeout> | undefined;

  const dropHeld = (): void => { clearTimeout(choiceTimer); choiceTimer = undefined; heldAudio = null; };

  const setPhase = (ev: Parameters<typeof nextPhase>[1], startedAt: number | null = null): void => {
    const phase = nextPhase(state.peek().phase, ev);
    state.value = { phase, startedAt: phase === 'recording' ? startedAt : null };
  };

  function press(opts: { held?: boolean } = {}): void {
    if (!enabled) return;
    const phase = state.peek().phase;
    if (phase === 'transcribing') { deps.flash('Still transcribing the last recording.'); return; }
    if (phase !== 'idle') return;
    const g = ++gen;
    held = opts.held === true;
    setPhase('press');
    void begin(g);
  }

  async function begin(g: number): Promise<void> {
    let r: ActiveRecording;
    try {
      r = await deps.start({
        maxMs: MAX_RECORDING_MS,
        onMaxLength: () => { if (g === gen) onMaxLength(); },
        onError: () => { if (g === gen) onRecorderError(); },
      });
    } catch (e) {
      if (g !== gen) return;
      setPhase('failed');
      deps.flash(recorderErrorMessage(e instanceof RecorderError ? e.code : 'failed'), 'error');
      return;
    }
    if (g !== gen) { r.cancel(); return; } // released, cancelled or disposed while the mic was opening
    rec = r;
    setPhase('started', deps.now());
  }

  /**
   * At the limit a recording whose key is still held is sent. A toggle-started one (touch) is stopped
   * and the microphone released, the audio stays in memory, and nothing is sent without an explicit
   * Send. No choice within CHOICE_TIMEOUT_MS discards it.
   */
  function onMaxLength(): void {
    if (state.peek().phase !== 'recording' || !rec) return;
    if (held) { deps.flash(MAX_LENGTH_MESSAGE); release(); return; }
    const r = rec;
    rec = null;
    const g = ++gen;
    setPhase('hold');
    const audio = r.stop();
    heldAudio = audio;
    audio.catch(() => {
      if (g !== gen || state.peek().phase !== 'confirming') return;
      dropHeld();
      gen++;
      setPhase('failed');
      deps.flash(INTERRUPTED_MESSAGE, 'error');
    });
    choiceTimer = setTimeout(() => {
      if (g !== gen || state.peek().phase !== 'confirming') return;
      gen++;
      dropHeld();
      setPhase('cancel');
      deps.flash(NO_CHOICE_MESSAGE, 'error');
    }, CHOICE_TIMEOUT_MS);
  }

  function send(): void {
    if (state.peek().phase !== 'confirming' || !heldAudio) return;
    const audio = heldAudio;
    dropHeld();
    setPhase('release');
    void finish(() => audio, ++gen);
  }

  function onRecorderError(): void {
    const p = state.peek().phase;
    if (p !== 'recording' && p !== 'starting') return;
    gen++;
    rec = null; // the recorder has already released the microphone
    setPhase('failed');
    deps.flash(INTERRUPTED_MESSAGE, 'error');
  }

  function release(): void {
    const s = state.peek();
    if (s.phase === 'starting') {
      // Let go before the microphone opened (begin() releases the mic when it arrives).
      gen++;
      setPhase('release');
      deps.flash(NOT_READY_MESSAGE);
      return;
    }
    if (s.phase !== 'recording' || !rec) return;
    const r = rec;
    rec = null;
    const duration = deps.now() - (s.startedAt ?? deps.now());
    if (isTooShort(duration)) {
      gen++;
      r.cancel();
      setPhase('too_short');
      deps.flash(TOO_SHORT_MESSAGE);
      return;
    }
    setPhase('release');
    void finish(() => r.stop(), ++gen);
  }

  async function finish(getBlob: () => Promise<Blob>, g: number): Promise<void> {
    const e = deps.epoch();
    const stale = (): boolean => g !== gen || e !== deps.epoch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const ac = new AbortController();
    try {
      let blob: Blob | null = await getBlob();
      if (stale()) return;
      if (uploadContentType(blob.type) === null) {
        setPhase('failed');
        deps.flash(BAD_FORMAT_MESSAGE, 'error');
        return;
      }
      abort = ac;
      timer = setTimeout(() => { timedOut = true; ac.abort(); }, UPLOAD_TIMEOUT_MS);
      const res = await deps.upload(blob, ac.signal);
      blob = null; // nothing keeps the audio once it is uploaded
      if (stale()) return;
      setPhase('uploaded');
      await handleTranscript(res?.text, e);
    } catch (err) {
      if (stale()) return;
      setPhase('failed');
      if (err instanceof RecorderError) { deps.flash(recorderErrorMessage(err.code), 'error'); return; }
      if (timedOut) { deps.flash(TIMEOUT_MESSAGE, 'error'); return; }
      const f = deps.failureOf(err);
      if (f?.status === 401) return; // the session lock covers this
      deps.flash(f ? transcribeFailureMessage(f) : 'Transcription failed.', 'error');
    } finally {
      clearTimeout(timer);
      if (abort === ac) abort = null;
    }
  }

  async function handleTranscript(text: unknown, e: number): Promise<void> {
    const action = decideTranscript(text, deps.people());
    if (action.kind === 'empty') { deps.flash(EMPTY_TRANSCRIPT_MESSAGE); return; }
    if (action.kind === 'dictation') { deps.dictate(action.text); return; }
    // Never navigate or start a meeting underneath an open overlay: keep the words as dictation.
    if (deps.overlayOpen()) { deps.dictate(String(text).trim()); return; }
    try {
      await deps.runCommand(action.command);
    } catch (err) {
      if (e !== deps.epoch()) return;
      const f = deps.failureOf(err);
      if (f?.status === 401) return;
      deps.flash('Could not run the voice command.', 'error');
    }
  }

  function cancel(): void {
    const s = state.peek();
    if (s.phase === 'idle') return;
    gen++;
    abort?.abort();
    abort = null;
    rec?.cancel();
    rec = null;
    dropHeld();
    setPhase('cancel');
    deps.flash(s.phase === 'transcribing' ? 'Transcription cancelled.' : s.phase === 'confirming' ? DISCARDED_MESSAGE : 'Recording cancelled.');
  }

  function toggle(): void {
    if (!enabled) return;
    const phase = state.peek().phase;
    if (phase === 'recording' || phase === 'starting') release();
    else press(); // idle: start; transcribing: tells the user to wait
  }

  function enable(): void { enabled = true; }

  function dispose(): void {
    enabled = false;
    gen++;
    abort?.abort();
    abort = null;
    rec?.cancel();
    rec = null;
    dropHeld();
    state.value = { phase: 'idle', startedAt: null };
  }

  return { state, enable, press, send, release, cancel, toggle, dispose };
}
