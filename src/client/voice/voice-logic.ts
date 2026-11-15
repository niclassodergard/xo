import { LIMITS } from '../../shared/api.ts';
import { parseVoiceCommand } from '../../shared/voice-commands.ts';
import type { PersonLike } from '../../shared/people-match.ts';
import type { ProjectLike } from '../../shared/project-match.ts';
import type { VoiceCommand } from '../../shared/types.ts';

// Pure voice logic (no DOM, no store): mime handling, state transitions, what to do with a transcript
// and the status-line text for each failure. Transcripts are never logged anywhere.

export const MAX_RECORDING_MS = 120_000;
/** Shorter recordings are accidental taps and are discarded without an upload. */
export const MIN_RECORDING_MS = 300;
/** A low bitrate keeps 120 s of speech far below the server's 10 MB limit. */
export const AUDIO_BITS_PER_SECOND = 32_000;
/** Client-side deadline for the upload + transcription request (the server's own deadline is longer). */
export const UPLOAD_TIMEOUT_MS = 100_000;
/** A recorder that does not report `stop` within this time is torn down. */
export const STOP_WATCHDOG_MS = 2000;
/** A held recording (reached max length, toggle-started) is discarded if the user makes no choice in time. */
export const CHOICE_TIMEOUT_MS = 60_000;

/** Preferred MediaRecorder types: Opus in WebM (Chrome/Firefox), MP4 (Safari), then Ogg. */
export const MIME_CANDIDATES: readonly string[] = [
  'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg',
];
/** Media types the voice route accepts (parameters such as `;codecs=opus` are ignored by it). */
const UPLOADABLE: ReadonlySet<string> = new Set(['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav']);

export function pickMime(isSupported: (type: string) => boolean): string | null {
  for (const m of MIME_CANDIDATES) {
    try { if (isSupported(m)) return m; } catch { /* treat as unsupported */ }
  }
  return null;
}

/** The server-accepted media type for a recorded blob/recorder type, or null when it would be a 415. */
export function uploadContentType(type: string): string | null {
  const base = (type.split(';', 1)[0] ?? '').trim().toLowerCase();
  return UPLOADABLE.has(base) ? base : null;
}

// ---- state machine ------------------------------------------------------------------------

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'confirming' | 'transcribing';
export type VoiceEvent =
  | 'press' | 'started' | 'release' | 'hold' | 'cancel' | 'too_short' | 'uploaded' | 'failed';

/**
 * A toggle-started recording that hits the maximum length goes recording -hold-> confirming (audio
 * kept in memory, waiting for an explicit Send = release, or Discard = cancel).
 * idle -press-> starting -started-> recording -release-> transcribing -uploaded|failed-> idle.
 * cancel and too_short return to idle from starting/recording; release while starting means the key
 * was let go before the microphone opened (a tap), so it also returns to idle. Anything else is a no-op.
 */
export function nextPhase(phase: VoicePhase, ev: VoiceEvent): VoicePhase {
  switch (phase) {
    case 'idle': return ev === 'press' ? 'starting' : phase;
    case 'starting':
      if (ev === 'started') return 'recording';
      return ev === 'cancel' || ev === 'release' || ev === 'failed' ? 'idle' : phase;
    case 'recording':
      if (ev === 'release') return 'transcribing';
      if (ev === 'hold') return 'confirming';
      return ev === 'cancel' || ev === 'too_short' || ev === 'failed' ? 'idle' : phase;
    case 'confirming':
      if (ev === 'release') return 'transcribing';
      return ev === 'cancel' || ev === 'failed' ? 'idle' : phase;
    case 'transcribing':
      return ev === 'uploaded' || ev === 'failed' || ev === 'cancel' ? 'idle' : phase;
  }
}

export function isTooShort(durationMs: number): boolean {
  return durationMs < MIN_RECORDING_MS;
}

// ---- transcript handling ------------------------------------------------------------------

export type TranscriptAction =
  | { kind: 'empty' }
  | { kind: 'command'; command: VoiceCommand }
  | { kind: 'dictation'; text: string };

export function decideTranscript(transcript: unknown, people: PersonLike[], projects: ProjectLike[] = []): TranscriptAction {
  if (typeof transcript !== 'string') return { kind: 'empty' };
  const text = transcript.trim();
  if (text === '') return { kind: 'empty' };
  const command = parseVoiceCommand(text, people, projects);
  return command ? { kind: 'command', command } : { kind: 'dictation', text };
}

/** Append dictated text to what is already in the chat input, separated by one space. */
export function appendDictation(draft: string, text: string): string {
  const t = text.trim();
  if (t === '') return draft;
  if (draft === '' || /\s$/u.test(draft)) return draft + t;
  return `${draft} ${t}`;
}

/** Append dictation to the draft, cutting at the capture limit. `truncated` tells the caller to say so. */
export function fitDraft(draft: string, text: string, limit: number = LIMITS.captureText): { draft: string; truncated: boolean } {
  const joined = appendDictation(draft, text);
  if (joined.length <= limit) return { draft: joined, truncated: false };
  let cut = joined.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // do not leave half a surrogate pair
  return { draft: cut, truncated: true };
}

// ---- messages -----------------------------------------------------------------------------

export const EMPTY_TRANSCRIPT_MESSAGE = "Didn't catch anything. Try again, closer to the microphone.";
export const NOT_READY_MESSAGE = "Microphone wasn't ready. Hold until REC shows.";
export const INTERRUPTED_MESSAGE = 'Recording stopped unexpectedly.';
export const CHOICE_TEXT = `Recording reached ${MAX_RECORDING_MS / 60_000} min`;
export const DISCARDED_MESSAGE = 'Recording discarded.';
export const NO_CHOICE_MESSAGE = 'Recording discarded: no choice was made.';
export const TIMEOUT_MESSAGE = 'Transcription timed out.';
export const TOO_SHORT_MESSAGE = 'Too short. Hold the key (or the mic button) while you speak.';
export const UNSUPPORTED_BROWSER_MESSAGE = 'Voice input is not supported in this browser (needs MediaRecorder and HTTPS).';
export const MIC_DENIED_MESSAGE = 'Microphone access was denied. Allow it in the browser site settings and try again.';
export const NO_MIC_MESSAGE = 'No microphone found.';
export const MIC_FAILED_MESSAGE = 'Could not start recording.';
export const BAD_FORMAT_MESSAGE = "This browser's audio format is not supported.";
export const MAX_LENGTH_MESSAGE = `Reached the ${MAX_RECORDING_MS / 1000} s limit; transcribing what was recorded.`;

export interface FailureLike { status: number; code: string; retryAfter: number | null }

/** Status-line text for a failed transcription request. Never includes server-supplied text. */
export function transcribeFailureMessage(f: FailureLike): string {
  const wait = f.retryAfter !== null && f.retryAfter > 0 ? ` Try again in ${Math.min(f.retryAfter, 3600)} s.` : ' Try again shortly.';
  switch (f.status) {
    case 0: return 'Cannot reach the server.';
    case 413: return 'The recording is too large to upload.';
    case 415: return 'The server does not accept this audio format.';
    case 429:
      return f.code === 'busy'
        ? `Transcription is busy.${wait}`
        : `Too many voice requests.${wait}`;
    case 502: return 'Transcription failed at the provider. Try again, or type it instead.';
    case 503: return 'Voice transcription is not available (not configured). Type it instead.';
    default: return 'Transcription failed.';
  }
}

export function recorderErrorMessage(code: 'unsupported' | 'denied' | 'no_device' | 'failed' | 'interrupted'): string {
  switch (code) {
    case 'unsupported': return UNSUPPORTED_BROWSER_MESSAGE;
    case 'denied': return MIC_DENIED_MESSAGE;
    case 'no_device': return NO_MIC_MESSAGE;
    case 'failed': return MIC_FAILED_MESSAGE;
    case 'interrupted': return INTERRUPTED_MESSAGE;
  }
}

/** m:ss for the recording timer. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
