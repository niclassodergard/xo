import { effect, signal } from '@preact/signals';
import { LIMITS } from '../../shared/api.ts';
import { api, ApiError } from '../lib/api.ts';
import { engine, focusContext, isTextEntry, keystrokeMark, onKeyUp, registerCommand, typedSince } from '../lib/keys.ts';
import { KEY_PTT, KEY_PTT_ANYWHERE } from '../lib/keymap.ts';
import { goToComposer } from '../lib/layout.ts';
import { startMeeting } from '../lib/commands.ts';
import { openDocAsync } from '../lib/nav.ts';
import { closePanel } from '../lib/router.ts';
import {
  appendVoiceDraft, chatDraft, confirmRequest, epoch, flash, overlay, people, personName, pickRequest, projectTitle, projects, promptRequest, session,
} from '../lib/store.ts';
import { createVoiceController } from './controller.ts';
import type { VoiceController } from './controller.ts';
import { startRecording } from './recorder.ts';
import { fitDraft } from './voice-logic.ts';

// Voice: push-to-talk, dictation and voice commands.
//
// Keys: hold Space (focus not in a text field or on a button) or Option-Space (anywhere) to record, release to transcribe. While a
// recording or transcription is active a `modal` key layer is registered: Esc cancels (and does not
// reach the global Esc handler), Space/Alt+Space keep working (a second press stops a recording that
// the mic button or palette started). The mic button in the status line and the "Dictate" palette
// command toggle. initVoice() is called by the shell only while a session exists; its cleanup (and a
// session that becomes null) cancels any recording, aborts the upload, releases the microphone and
// removes every binding. A toggle-started recording that reaches the maximum length is held in memory
// for an explicit Send (Enter) or Discard (Esc); it is discarded after 60 s or on hidden/blur/session end.
// A recording is also discarded when the page is hidden or loses focus.

const overlayOpen = (): boolean =>
  overlay.peek() !== null || pickRequest.peek() !== null || promptRequest.peek() !== null || confirmRequest.peek() !== null;

/** True while Enter sends the recording at the Send/Discard prompt (the prompt shows the hint only then). */
export const sendByEnter = signal(false);

let controller: VoiceController | null = null;
/** Keystroke count when the current recording was sent for transcription (see runCommand). */
let transcribeMark: number | null = null;
/** A key held for push-to-talk counts as still held only with an auto-repeat keydown this recent. */
const HELD_PROOF_MS = 1000;
/** Typing this recently when the Send/Discard prompt appears: Enter is not armed yet (it would send the draft). */
const TYPING_QUIET_MS = 1500;
let heldProofAt = 0;
let lastTypedAt = 0;
/** Which key a push-to-talk recording is held by (null: not held, e.g. started by the mic button). */
let heldBy: 'space' | 'alt+space' | null = null;

function getController(): VoiceController {
  controller ??= createVoiceController({
    start: (o) => startRecording(o),
    upload: (blob, signal) => api.postAudio('/api/voice/transcribe', blob, signal),
    people: () => people.value,
    projects: () => projects.value,
    heldAlive: () => heldBy !== null && Date.now() - heldProofAt < HELD_PROOF_MS,
    epoch,
    now: () => Date.now(),
    flash,
    overlayOpen,
    failureOf: (e) => (e instanceof ApiError ? { status: e.status, code: e.code, retryAfter: e.retryAfter } : null),
    dictate(text) {
      // Typed since the audio was sent: the words only join the draft; no navigation, no focus change.
      const mark = transcribeMark ?? keystrokeMark();
      transcribeMark = null;
      const typed = typedSince(mark);
      const fit = fitDraft(chatDraft.value, text);
      appendVoiceDraft(fit.draft);
      if (fit.truncated) flash(`Dictation cut at ${LIMITS.captureText} characters.`, 'error');
      if (overlayOpen() || typed) { // never navigate or steal focus from an open overlay or from typing
        if (!fit.truncated) flash('Dictation added to chat');
        return;
      }
      goToComposer(); // single-panel mode with a document open goes to the chat first
    },
    async runCommand(cmd) {
      // Typing during the transcription must not lose its focus to the opened document: the mark is the one
      // taken when the audio was sent, else now. openDocAsync leaves focus alone when the user typed since.
      const mark = transcribeMark ?? keystrokeMark();
      transcribeMark = null;
      if (cmd.type === 'goto') {
        if (cmd.view === 'home') { closePanel(); flash('Voice: opened chat'); } else { openDocAsync({ kind: cmd.view }, mark); flash(`Voice: opened ${cmd.view}`); }
        return;
      }
      if (cmd.type === 'open_person') { openDocAsync({ kind: 'person', id: cmd.personId }, mark); flash(`Voice: opened ${personName(cmd.personId) ?? 'person'}`); return; }
      if (cmd.type === 'open_project') { openDocAsync({ kind: 'project', id: cmd.projectId }, mark); flash(`Voice: opened ${projectTitle(cmd.projectId) ?? 'project'}`); return; }
      const e = epoch();
      await startMeeting(cmd.personId, mark);
      if (e === epoch()) flash(`Voice: started 1-1 with ${personName(cmd.personId) ?? 'person'}`);
    },
  });
  return controller;
}

/** Current voice state for the indicator (phase and recording start time). */
export function voiceState() {
  return getController().state;
}
/** Send / discard the recording that reached the maximum length (indicator buttons). */
export function sendRecording(): void { getController().send(); }
export function discardRecording(): void { getController().cancel(); }
/** Mic button / palette: start recording, or stop and transcribe. */
export function toggleDictation(): void {
  getController().toggle();
}

export function initVoice(): () => void {
  const c = getController();
  heldBy = null;
  c.enable();

  const down = (by: 'space' | 'alt+space') => (e: KeyboardEvent): void => {
    if (e?.repeat) return; // auto-repeat while held
    const p = c.state.peek().phase;
    if (p === 'idle') { heldBy = by; heldProofAt = Date.now(); c.press({ held: true }); }
    else if (p === 'recording' || p === 'starting') { if (heldBy === null) c.release(); } // stops a toggle-started recording
    else c.press(); // transcribing: shows "still transcribing"
  };
  const removeBase = [
    engine.addLayer({ scope: 'global', bindings: [{ spec: KEY_PTT, run: down('space'), description: 'Hold to talk (push-to-talk)' }] }),
    engine.addLayer({ scope: 'global', bindings: [{ spec: KEY_PTT_ANYWHERE, run: down('alt+space'), description: 'Hold to talk (anywhere)' }] }),
  ];

  // Active (starting/recording/transcribing/confirming): a modal layer takes Esc before the global handler can,
  // and keeps Space/Alt+Space from falling through (page scroll) while lower layers are blocked.
  let removeModal: (() => void)[] | null = null;
  const cancelByKey = (): void => { heldBy = null; c.cancel(); };

  // Enter sends the recording only while the Send/Discard prompt is on screen AND the user is not typing: the
  // engine leaves Enter to a focused text field, so the field is blurred when Enter is armed (else the composer
  // would send the draft), and put back afterwards. If the user typed within TYPING_QUIET_MS of the prompt
  // appearing, the prompt stays (Send/Discard are buttons) and Enter is armed once typing has stopped.
  let blurred: HTMLElement | null = null;
  let removeEnter: (() => void) | null = null;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    armTimer = undefined;
    if (c.state.peek().phase !== 'confirming' || removeEnter) return;
    // A focused text field, button or link would take Enter itself (send the draft / click): drop its focus, except
    // inside the prompt itself.
    const active = document.activeElement as HTMLElement | null;
    if (!blurred && active && !active.closest?.('.voice-status') && (isTextEntry(active) || focusContext(active, active).nativeActivation)) {
      blurred = active;
      blurred.blur();
    }
    sendByEnter.value = true;
    removeEnter = engine.addLayer({
      scope: 'modal',
      // Ignore key repeat: a held Enter must never count as the explicit Send.
      bindings: [{ spec: 'enter', run: (e) => { if (!e.repeat) c.send(); }, description: 'Send the recording that reached the limit' }],
    });
  };
  const armWhenQuiet = (): void => {
    const wait = TYPING_QUIET_MS - (Date.now() - lastTypedAt);
    if (wait <= 0) arm();
    else armTimer = setTimeout(armWhenQuiet, wait);
  };
  const disarm = (): void => {
    clearTimeout(armTimer);
    armTimer = undefined;
    removeEnter?.();
    removeEnter = null;
    sendByEnter.value = false;
  };
  const stopWatch = effect(() => {
    const phase = c.state.value.phase;
    if (phase === 'confirming') {
      if (!removeEnter && armTimer === undefined) armWhenQuiet();
    } else {
      disarm();
      if (phase === 'idle' && blurred) {
        const el = blurred;
        blurred = null;
        const a = document.activeElement;
        if (el.isConnected && (a === null || a === document.body)) el.focus();
      }
    }
    if (phase === 'starting') transcribeMark = null;
    else if (phase === 'transcribing' && transcribeMark === null) transcribeMark = keystrokeMark();
    const active = phase !== 'idle';
    if (active && !removeModal) {
      removeModal = [
        engine.addLayer({
          scope: 'modal',
          bindings: [{ spec: 'esc', run: cancelByKey, description: 'Cancel recording' }, { spec: KEY_PTT_ANYWHERE, run: down('alt+space') }],
        }),
        engine.addLayer({ scope: 'modal', bindings: [{ spec: KEY_PTT, run: down('space') }] }),
      ];
    } else if (!active && removeModal) {
      for (const r of removeModal) r();
      removeModal = null;
    }
  });

  // Typing time (for the Enter arming above) and proof that a held key is really held: macOS suppresses the
  // keyup of Space while Cmd is down, so a hold counts as alive only with a recent auto-repeat keydown, and a
  // keydown with Cmd ends the hold (the recording then needs an explicit stop, or ends at the Send/Discard prompt).
  const onKeyDown = (e: KeyboardEvent): void => {
    if (isTextEntry(document.activeElement)) lastTypedAt = Date.now();
    if (heldBy === null) return;
    if (e.metaKey) {
      heldBy = null;
      if (c.state.peek().phase === 'recording') flash('Recording continues. Press Space or the mic button to stop it.');
    } else if (e.repeat && e.code === 'Space') heldProofAt = Date.now();
  };
  window.addEventListener('keydown', onKeyDown, true);

  const offKeyUp = onKeyUp((e) => {
    if (heldBy === null || e.code !== 'Space') return;
    heldBy = null;
    c.release();
  });

  // Unattended recordings are discarded: hidden tab, page leaving, or window focus lost (a keyup
  // would be lost too).
  const discard = (): void => {
    const p = c.state.peek().phase;
    if (p === 'recording' || p === 'starting' || p === 'confirming') { heldBy = null; c.cancel(); }
  };
  const onVisibility = (): void => { if (document.visibilityState === 'hidden') discard(); };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', discard);
  window.addEventListener('blur', discard);

  // Session ended (401, logout, other tab): tear down at once instead of waiting for effect timing.
  const stopSession = effect(() => {
    if (session.value === null) { heldBy = null; c.dispose(); }
  });

  const offCommand = registerCommand({
    id: 'voice.dictate', title: 'Dictate (start/stop microphone)', keywords: ['voice', 'mic', 'record', 'talk'],
    run: () => { heldBy = null; c.toggle(); },
  });

  return () => {
    stopSession();
    stopWatch();
    for (const r of removeBase) r();
    if (removeModal) for (const r of removeModal) r();
    removeModal = null;
    offKeyUp();
    offCommand();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', discard);
    window.removeEventListener('blur', discard);
    window.removeEventListener('keydown', onKeyDown, true);
    disarm();
    blurred = null;
    heldBy = null;
    c.dispose();
  };
}
