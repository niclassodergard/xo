import { describe, expect, it } from 'vitest';
import {
  MIN_RECORDING_MS, appendDictation, fitDraft, decideTranscript, formatElapsed, isTooShort, nextPhase, pickMime,
  recorderErrorMessage, transcribeFailureMessage, uploadContentType,
} from './voice-logic.ts';
import type { VoiceEvent, VoicePhase } from './voice-logic.ts';

const people = [{ id: 1, name: 'Anna Berg', aliases: [] as string[] }, { id: 2, name: 'Bo Lind', aliases: [] as string[] }];

describe('pickMime / uploadContentType', () => {
  it('prefers webm/opus, falls back to mp4 for Safari, null when nothing is supported', () => {
    expect(pickMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMime(() => false)).toBeNull();
    expect(pickMime(() => { throw new Error('x'); })).toBeNull();
  });
  it('maps recorder types to server-accepted media types and rejects the rest', () => {
    expect(uploadContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(uploadContentType('AUDIO/MP4')).toBe('audio/mp4');
    expect(uploadContentType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(uploadContentType('audio/x-m4a')).toBeNull();
    expect(uploadContentType('video/webm')).toBeNull();
    expect(uploadContentType('')).toBeNull();
  });
});

describe('nextPhase', () => {
  const walk = (start: VoicePhase, evs: VoiceEvent[]) => evs.reduce(nextPhase, start);
  it('runs the happy path', () => {
    expect(walk('idle', ['press', 'started', 'release', 'uploaded'])).toBe('idle');
    expect(walk('idle', ['press', 'started', 'release'])).toBe('transcribing');
  });
  it('cancel, too_short, early release and failures return to idle', () => {
    expect(walk('idle', ['press', 'started', 'cancel'])).toBe('idle');
    expect(walk('idle', ['press', 'started', 'too_short'])).toBe('idle');
    expect(walk('idle', ['press', 'release'])).toBe('idle');
    expect(walk('idle', ['press', 'failed'])).toBe('idle');
    expect(walk('idle', ['press', 'started', 'release', 'failed'])).toBe('idle');
  });
  it('holds a recording for a choice: Send continues, Discard and failure go idle', () => {
    expect(walk('idle', ['press', 'started', 'hold'])).toBe('confirming');
    expect(walk('idle', ['press', 'started', 'hold', 'release'])).toBe('transcribing');
    expect(walk('idle', ['press', 'started', 'hold', 'cancel'])).toBe('idle');
    expect(walk('idle', ['press', 'started', 'hold', 'failed'])).toBe('idle');
    expect(nextPhase('confirming', 'press')).toBe('confirming');
    expect(nextPhase('confirming', 'started')).toBe('confirming');
  });
  it('ignores events that make no sense in the current phase', () => {
    expect(nextPhase('idle', 'release')).toBe('idle');
    expect(nextPhase('recording', 'press')).toBe('recording');
    expect(nextPhase('transcribing', 'press')).toBe('transcribing');
    expect(nextPhase('transcribing', 'release')).toBe('transcribing');
  });
});

describe('isTooShort', () => {
  it('discards taps under the minimum', () => {
    expect(isTooShort(0)).toBe(true);
    expect(isTooShort(MIN_RECORDING_MS - 1)).toBe(true);
    expect(isTooShort(MIN_RECORDING_MS)).toBe(false);
  });
});

describe('decideTranscript', () => {
  it('runs commands', () => {
    expect(decideTranscript('Open Anna.', people)).toEqual({ kind: 'command', command: { type: 'open_person', personId: 1 } });
    expect(decideTranscript('start 1-1 with Anna', people)).toEqual({ kind: 'command', command: { type: 'start_meeting', personId: 1 } });
    expect(decideTranscript('go to actions', people)).toEqual({ kind: 'command', command: { type: 'goto', view: 'actions' } });
  });
  it('opens a project, and a project name is dictation without the project list', () => {
    const projects = [{ id: 7, title: 'Board deck', aliases: [] }];
    expect(decideTranscript('open Board deck', people, projects)).toEqual({ kind: 'command', command: { type: 'open_project', projectId: 7 } });
    expect(decideTranscript('open Board deck', people)).toEqual({ kind: 'dictation', text: 'open Board deck' });
  });
  it('turns everything else into dictation, trimmed (unknown person included)', () => {
    expect(decideTranscript('  buy milk tomorrow ', people)).toEqual({ kind: 'dictation', text: 'buy milk tomorrow' });
    expect(decideTranscript('open Zelda', people)).toEqual({ kind: 'dictation', text: 'open Zelda' });
  });
  it('reports empty or non-string transcripts', () => {
    expect(decideTranscript('', people)).toEqual({ kind: 'empty' });
    expect(decideTranscript('   \n', people)).toEqual({ kind: 'empty' });
    expect(decideTranscript(undefined, people)).toEqual({ kind: 'empty' });
    expect(decideTranscript(42, people)).toEqual({ kind: 'empty' });
  });
});

describe('appendDictation', () => {
  it('appends with one space and never auto-adds to an empty draft', () => {
    expect(appendDictation('', 'hello')).toBe('hello');
    expect(appendDictation('note:', ' hello ')).toBe('note: hello');
    expect(appendDictation('trailing ', 'hello')).toBe('trailing hello');
    expect(appendDictation('keep', '  ')).toBe('keep');
  });
});

describe('messages', () => {
  const f = (status: number, code = 'x', retryAfter: number | null = null) => transcribeFailureMessage({ status, code, retryAfter });
  it('covers 413, 415, 429 (both codes), 502, 503, network and unknown', () => {
    expect(f(413)).toMatch(/too large/);
    expect(f(415)).toMatch(/format/);
    expect(f(429, 'rate_limited', 12)).toMatch(/Too many voice requests.*12 s/);
    expect(f(429, 'busy', 5)).toMatch(/busy.*5 s/);
    expect(f(429, 'busy')).toMatch(/shortly/);
    expect(f(502)).toMatch(/provider/);
    expect(f(503)).toMatch(/not available/);
    expect(f(0)).toMatch(/Cannot reach/);
    expect(f(500)).toBe('Transcription failed.');
  });
  it('has a message per recorder error', () => {
    expect(recorderErrorMessage('denied')).toMatch(/denied/);
    expect(recorderErrorMessage('unsupported')).toMatch(/not supported/);
    expect(recorderErrorMessage('no_device')).toMatch(/No microphone/);
    expect(recorderErrorMessage('failed')).toMatch(/Could not/);
  });
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_900)).toBe('1:05');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('fitDraft', () => {
  it('appends within the limit and cuts (reporting it) beyond it', () => {
    expect(fitDraft('a', 'b', 10)).toEqual({ draft: 'a b', truncated: false });
    expect(fitDraft('abc', 'defghij', 6)).toEqual({ draft: 'abc de', truncated: true });
  });
  it('does not leave half a surrogate pair', () => {
    const r = fitDraft('', 'a\u{1F600}b', 2);
    expect(r.truncated).toBe(true);
    expect(r.draft).toBe('a');
  });
});
