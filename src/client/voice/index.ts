import { effect } from '@preact/signals';
import { LIMITS } from '../../shared/api.ts';
import { api, ApiError } from '../lib/api.ts';
import { engine, onKeyUp, registerCommand } from '../lib/keys.ts';
import { navigate, route } from '../lib/router.ts';
import {
  chatDraft, epoch, flash, focusChatInput, overlay, people, personPicker, promptRequest, session,
} from '../lib/store.ts';
import type { MeetingDetail } from '../../shared/types.ts';
import { createVoiceController } from './controller.ts';
import type { VoiceController } from './controller.ts';
import { startRecording } from './recorder.ts';
import { fitDraft } from './voice-logic.ts';

// Voice: push-to-talk, dictation and voice commands.
//
// Keys: hold Space (NORMAL mode) or Alt+Space (any mode) to record, release to transcribe. While a
// recording or transcription is active a `modal` key layer is registered: Esc cancels (and does not
// reach the global Esc handler), Space/Alt+Space keep working (a second press stops a recording that
// the mic button or palette started). The mic button in the status line and the "Dictate" palette
// command toggle. initVoice() is called by the shell only while a session exists; its cleanup (and a
// session that becomes null) cancels any recording, aborts the upload, releases the microphone and
// removes every binding. A toggle-started recording that reaches the maximum length is held in memory
// for an explicit Send (Enter) or Discard (Esc); it is discarded after 60 s or on hidden/blur/session end.
// A recording is also discarded when the page is hidden or loses focus.

const overlayOpen = (): boolean => overlay.peek() !== null || personPicker.peek() !== null || promptRequest.peek() !== null;

function personName(id: number): string {
  return people.peek().find((p) => p.id === id)?.name ?? 'person';
}

let controller: VoiceController | null = null;

function getController(): VoiceController {
  controller ??= createVoiceController({
    start: (o) => startRecording(o),
    upload: (blob, signal) => api.postAudio('/api/voice/transcribe', blob, signal),
    people: () => people.value,
    epoch,
    now: () => Date.now(),
    flash,
    overlayOpen,
    failureOf: (e) => (e instanceof ApiError ? { status: e.status, code: e.code, retryAfter: e.retryAfter } : null),
    dictate(text) {
      const fit = fitDraft(chatDraft.value, text);
      chatDraft.value = fit.draft;
      if (fit.truncated) flash(`Dictation cut at ${LIMITS.captureText} characters.`, 'error');
      if (overlayOpen()) { // never navigate or steal focus from an open overlay
        if (!fit.truncated) flash('Dictation added to chat');
        return;
      }
      if (route.peek().name !== 'chat') navigate('/chat');
      focusChatInput();
    },
    async runCommand(cmd) {
      if (cmd.type === 'goto') { navigate(`/${cmd.view}`); flash(`Voice: opened ${cmd.view}`); return; }
      if (cmd.type === 'open_person') { navigate(`/people/${cmd.personId}`); flash(`Voice: opened ${personName(cmd.personId)}`); return; }
      const e = epoch();
      const detail = await api.post<MeetingDetail>(`/api/people/${cmd.personId}/meetings`);
      if (e !== epoch()) return;
      navigate(`/meetings/${detail.meeting.id}`);
      flash(`Voice: started 1-1 with ${personName(cmd.personId)}`);
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
  let heldBy: 'space' | 'alt+space' | null = null;
  c.enable();

  const down = (by: 'space' | 'alt+space') => (e: KeyboardEvent): void => {
    if (e?.repeat) return; // auto-repeat while held
    const p = c.state.peek().phase;
    if (p === 'idle') { heldBy = by; c.press({ held: true }); }
    else if (p === 'recording' || p === 'starting') { if (heldBy === null) c.release(); } // stops a toggle-started recording
    else c.press(); // transcribing: shows "still transcribing"
  };
  const removeBase = [
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'space', run: down('space'), description: 'Hold to talk (push-to-talk)' }] }),
    engine.addLayer({ scope: 'global', modes: ['normal', 'insert', 'command'], bindings: [{ spec: 'alt+space', run: down('alt+space'), description: 'Hold to talk (any mode)' }] }),
  ];

  // Active (starting/recording/transcribing): a modal layer takes Esc before the global handler can,
  // and keeps Space/Alt+Space from falling through (page scroll) while lower layers are blocked.
  let removeModal: (() => void)[] | null = null;
  const cancelByKey = (): void => { heldBy = null; c.cancel(); };
  const stopWatch = effect(() => {
    const active = c.state.value.phase !== 'idle';
    if (active && !removeModal) {
      removeModal = [
        engine.addLayer({
          scope: 'modal', modes: ['normal', 'insert', 'command'],
          bindings: [{ spec: 'esc', run: cancelByKey, description: 'Cancel recording' }, { spec: 'alt+space', run: down('alt+space') }],
        }),
        engine.addLayer({
          scope: 'modal', modes: ['normal'],
          bindings: [
            { spec: 'space', run: down('space') },
            // Ignore key repeat: a held Enter must never count as the explicit Send.
            { spec: 'enter', run: (e) => { if (!e.repeat) c.send(); }, description: 'Send the recording that reached the limit' },
          ],
        }),
      ];
    } else if (!active && removeModal) {
      for (const r of removeModal) r();
      removeModal = null;
    }
  });

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
    heldBy = null;
    c.dispose();
  };
}
