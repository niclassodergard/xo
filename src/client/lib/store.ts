import { computed, effect, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useLayoutEffect } from 'preact/hooks';
import type { Capture, Person } from '../../shared/types.ts';
import type { CapturesListResponse, PeopleListResponse, SessionResponse } from '../../shared/api.ts';
import { api, ApiError } from './api.ts';
import { mode } from './keys.ts';
import { navigate } from './router.ts';

/*
 * CONVENTIONS for views and features (steps 8-10)
 *
 * 1. Session epoch. Whenever the session ends (401, logout, logout in another tab) the epoch
 *    advances. Any async load that writes to a store signal must capture `epoch()` BEFORE its await
 *    and drop the result if `epoch()` changed, so a late response can never repopulate the store
 *    after the session ended:
 *        const e = epoch(); const r = await api.get(...); if (e !== epoch()) return;
 * 2. A 401 does NOT unmount the shell. `session` becomes null, a Login overlay covers the hidden, inert
 *    shell, and the VIEW subtree is unmounted (appPhase() === 'locked'), so no server-loaded content
 *    stays in the DOM behind the curtain. What survives is only what the user typed, held in signals:
 *    chatDraft, searchQuery and `drafts` (unsaved TextEdit text, keyed by the editor's stable `id`).
 *    Give every TextEdit that edits server data a stable `id`. After re-login the views remount,
 *    reload, and TextEdit re-applies and retries its pending draft. Component state is NOT preserved,
 *    so anything the user typed must live in one of those signals. Only an explicit logout() wipes drafts.
 * 3. Overlays register a 'modal' key layer (see lib/keys.ts) so keys never reach views behind them.
 *    Focus an overlay's input synchronously (useLayoutEffect / ref callback), never in useEffect.
 * 4. To focus the chat or search input from outside, call requestFocus('chat'|'search'); the view
 *    calls useFocusRequest('chat', () => inputEl). The hook re-checks after every render of the view
 *    until the input exists or the request expires (1 s), but chat and search inputs should render
 *    from the first render rather than appear conditionally.
 * 5. A save (TextEdit onSave, or any write) must return its promise; "saved" means resolved. A failed
 *    save leaves the draft dirty and it is retried on the next blur/unmount/re-login.
 */

/** CSRF token lives in memory only (never localStorage); re-fetched from /api/auth/session on load. */
export const session: Signal<{ csrfToken: string } | null> = signal<{ csrfToken: string } | null>(null);
/** False until the first /api/auth/session check has finished. */
export const booted: Signal<boolean> = signal(false);
/** True once the user has been logged in; stays true across a 401 (Login overlay), false after logout(). */
export const shellActive: Signal<boolean> = signal(false);
export const people: Signal<Person[]> = signal<Person[]>([]);
/** Chat input text (voice dictation writes here). */
export const chatDraft: Signal<string> = signal('');
/**
 * How many characters of `chatDraft` came from voice dictation. Only the voice module adds to it
 * (`appendVoiceDraft`); typing calls `editChatDraft`, which caps it at the new length. It resets when the
 * draft becomes empty (send, logout). A 401 keeps it, like the draft itself.
 */
const chatVoiceChars: Signal<number> = signal(0);
/**
 * Where the current chat draft came from, sent as the capture `source`. RULE: a dictated draft that is
 * edited by typing stays 'voice' while more than half of its characters are still dictated; typing a lot
 * (or recalling history) turns it into 'text'. Fixing a misheard word keeps 'voice'.
 */
export const chatDraftSource: Signal<'text' | 'voice'> = computed(() => (chatVoiceChars.value * 2 > chatDraft.value.length ? 'voice' : 'text'));
/** The user typed in (or recalled text into) the chat input. `recalled` = the text did not come from this draft. */
export function editChatDraft(value: string, recalled = false): void {
  chatDraft.value = value;
  chatVoiceChars.value = recalled ? 0 : Math.min(chatVoiceChars.peek(), value.length);
}
/** Voice dictation appended to the draft: `next` is the new draft, the characters added are counted as voice. */
export function appendVoiceDraft(next: string): void {
  const before = chatDraft.peek().length;
  chatDraft.value = next;
  const added = Math.max(0, next.length - before);
  chatVoiceChars.value = Math.min(chatVoiceChars.peek() + added, next.length);
}
/** Put back text that was never sent, keeping its source. */
export function restoreChatDraft(text: string, source: 'text' | 'voice'): void {
  chatDraft.value = text;
  chatVoiceChars.value = source === 'voice' ? text.length : 0;
}
/** Put unsent text in front of what the user has typed since, counting it as voice when it was dictated. */
export function prependChatDraft(text: string, source: 'text' | 'voice'): void {
  const cur = chatDraft.peek();
  const next = cur ? `${text} ${cur}` : text;
  const voice = chatVoiceChars.peek() + (source === 'voice' ? text.length : 0);
  chatDraft.value = next;
  chatVoiceChars.value = Math.min(voice, next.length);
}
/**
 * Text typed before history recall (Alt-up) replaced it, with its source. Module level, so it survives a
 * remount and a 401 like the draft itself; wiped on logout. It stays until Alt-down steps past the newest
 * entry (restoring it) or the user clears the input, and is put back after a send (see takeChatStash).
 */
export const chatStash: Signal<{ text: string; source: 'text' | 'voice' } | null> = signal<{ text: string; source: 'text' | 'voice' } | null>(null);
/** Put the stashed text back into the (now empty) input, keeping its source. Returns whether there was one. */
export function takeChatStash(): boolean {
  const st = chatStash.peek();
  if (!st) return false;
  chatStash.value = null;
  restoreChatDraft(st.text, st.source);
  return true;
}
/** Search input text; kept in client state so it never lands in the URL. */
export const searchQuery: Signal<string> = signal('');
/** Unsaved TextEdit text by editor id. Survives a 401 (views unmount); wiped by logout(). */
export const drafts: Signal<Record<string, string>> = signal<Record<string, string>>({});
export function setDraft(id: string, value: string): void {
  drafts.value = { ...drafts.value, [id]: value };
}
/** Keep `drafts[id]` only while the text differs from the saved value (reverting to it drops the entry). */
export function syncDraft(id: string, value: string, saved: string): void {
  if (value === saved) {
    if (id in drafts.peek()) {
      const { [id]: _gone, ...rest } = drafts.peek();
      drafts.value = rest;
    }
  } else {
    setDraft(id, value);
  }
}
/** Remove a draft once it has been saved (only if the user has not typed something newer since). */
export function clearDraft(id: string, savedValue: string): void {
  if (drafts.peek()[id] !== savedValue) return;
  const { [id]: _gone, ...rest } = drafts.peek();
  drafts.value = rest;
}

export type AppPhase = 'boot' | 'login' | 'shell' | 'locked';
/** 'locked' = a 401 happened after login: shell stays, views are unmounted, Login covers it. */
export function appPhase(isBooted: boolean, isShellActive: boolean, isLoggedIn: boolean): AppPhase {
  if (!isBooted) return 'boot';
  if (!isShellActive) return 'login';
  return isLoggedIn ? 'shell' : 'locked';
}

let sessionEpoch = 0;
/** Advances every time the session ends. See convention 1. */
export function epoch(): number { return sessionEpoch; }

// ---- status-line messages -----------------------------------------------------------------

export interface FlashAction { label: string; run: () => void }
export interface Flash { message: string; kind: 'info' | 'error'; seq: number; action?: FlashAction }
export const flashMessage: Signal<Flash | null> = signal<Flash | null>(null);
let flashSeq = 0;
let flashTimer: ReturnType<typeof setTimeout> | undefined;

/** Status-line message. `sticky` messages stay until replaced or dismissed; `action` adds a button. */
export function flash(message: string, kind: 'info' | 'error' = 'info', opts: { sticky?: boolean; action?: FlashAction } = {}): void {
  const seq = ++flashSeq;
  flashMessage.value = { message, kind, seq, action: opts.action };
  clearTimeout(flashTimer);
  if (opts.sticky) return;
  flashTimer = setTimeout(() => {
    if (flashMessage.value?.seq === seq) flashMessage.value = null;
  }, kind === 'error' ? 6000 : 3500);
}

export function clearFlash(): void {
  clearTimeout(flashTimer);
  flashMessage.value = null;
}

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Something went wrong.';
}

// ---- overlays -----------------------------------------------------------------------------

export const overlay: Signal<'palette' | 'help' | null> = signal<'palette' | 'help' | null>(null);
export interface PickerRequest { onPick: (p: Person) => void }
export interface PromptRequest { label: string; onSubmit: (value: string) => void }
export const personPicker: Signal<PickerRequest | null> = signal<PickerRequest | null>(null);
export const promptRequest: Signal<PromptRequest | null> = signal<PromptRequest | null>(null);

// ---- session / data -----------------------------------------------------------------------

function closeAllOverlays(): void {
  overlay.value = null;
  personPicker.value = null;
  promptRequest.value = null;
}

effect(() => { if (session.value) shellActive.value = true; });
effect(() => { if (chatDraft.value === '') chatVoiceChars.value = 0; });

// Session ended (401, logout, other tab): invalidate in-flight loads, hide data, close overlays.
// Drafts are kept here on purpose (see convention 2); logout() wipes them.
effect(() => {
  if (session.value === null) {
    sessionEpoch++;
    people.value = [];
    clearFlash();
    closeAllOverlays();
  }
});

// Command mode only exists while the palette is open (e.g. a 401 with the palette open).
effect(() => {
  if (overlay.value !== 'palette' && mode.peek() === 'command') mode.value = 'normal';
});

export async function restoreSession(): Promise<void> {
  try {
    const r = await api.get<SessionResponse>('/api/auth/session');
    session.value = { csrfToken: r.csrfToken };
  } catch {
    session.value = null; // 401 (not logged in) or unreachable server: show Login
  } finally {
    booted.value = true;
  }
}

let lastCheck = 0;
/** Re-check the session when the tab becomes visible/focused (no timer: polling would defeat idle expiry). */
export async function revalidateSession(minGapMs = 5000): Promise<void> {
  if (session.value === null) return;
  const now = Date.now();
  if (now - lastCheck < minGapMs) return;
  lastCheck = now;
  try {
    const r = await api.get<SessionResponse>('/api/auth/session'); // a 401 clears the session in api.ts
    if (session.value && r.csrfToken !== session.value.csrfToken) session.value = { csrfToken: r.csrfToken };
  } catch { /* offline: keep what we have */ }
}

export async function refreshPeople(): Promise<void> {
  const e = epoch();
  try {
    const r = await api.get<PeopleListResponse>('/api/people');
    if (e !== epoch()) return;
    people.value = r.people;
  } catch (err) {
    if (e === epoch()) flash(`Could not load people: ${errorText(err)}`, 'error');
  }
}

// ---- logout -------------------------------------------------------------------------------

let channel: BroadcastChannel | null = null;

/** Tell other tabs about logout (message carries no data) and react to theirs. Call once. */
export function initAuthChannel(): () => void {
  if (typeof BroadcastChannel === 'undefined' || channel) return () => {};
  const ch = new BroadcastChannel('xo-auth');
  channel = ch;
  ch.onmessage = (ev: MessageEvent) => {
    if (ev.data === 'logout') endLocally();
  };
  return () => { ch.close(); if (channel === ch) channel = null; };
}

/** Wipe everything that belongs to the session, drafts included. */
function endLocally(): void {
  session.value = null;
  shellActive.value = false;
  chatDraft.value = '';
  chatStash.value = null;
  searchQuery.value = '';
  drafts.value = {};
  navigate('/chat', { replace: true });
}

/**
 * Only a 2xx or a 401 counts as logged out. Anything else (network, 403, 429, 5xx) leaves the user
 * signed in on this browser and says so, with a retry.
 */
export async function logout(): Promise<boolean> {
  try {
    await api.post('/api/auth/logout');
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) {
      flash("Logout didn't reach the server — you're still signed in on this browser.", 'error', {
        sticky: true, action: { label: 'retry', run: () => { void logout(); } },
      });
      return false;
    }
  }
  channel?.postMessage('logout');
  endLocally();
  return true;
}

/** `u`: undo the most recent filed capture. */
export async function undoLastCapture(): Promise<void> {
  const e = epoch();
  try {
    const r = await api.get<CapturesListResponse>('/api/captures?limit=50');
    if (e !== epoch()) return;
    const last = [...r.captures].reverse().find((c) => c.status === 'filed');
    if (!last) { flash('Nothing to undo'); return; }
    const c = await api.post<Capture>(`/api/captures/${last.id}/undo`);
    if (e === epoch()) flash(`Undone: ${c.summary}`);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}

// ---- overlay controls ---------------------------------------------------------------------

/**
 * Ctrl-K / ':' do nothing while a Prompt or person picker is open. Closing them first would throw away
 * what the user is typing, and stacking the palette behind them would send keystrokes to an invisible
 * input; a no-op is the simplest option that is always safe.
 */
export function openPalette(): void {
  if (overlay.value === 'palette' || personPicker.value || promptRequest.value) return;
  overlay.value = 'palette';
  mode.value = 'command';
}

export function togglePalette(): void {
  if (overlay.value === 'palette') closeOverlay();
  else openPalette();
}

export function toggleHelp(): void {
  overlay.value = overlay.value === 'help' ? null : 'help';
}

export function closeOverlay(): void {
  const wasPalette = overlay.value === 'palette';
  overlay.value = null;
  if (wasPalette) mode.value = 'normal'; // focus goes back to where it was in components/Overlay.tsx
}

export function pickPerson(onPick: (p: Person) => void): void {
  personPicker.value = { onPick };
}

export function askText(label: string, onSubmit: (value: string) => void): void {
  promptRequest.value = { label, onSubmit };
}

// ---- focus requests -----------------------------------------------------------------------

export type FocusTarget = 'chat' | 'search';
export const focusRequest: Signal<{ target: FocusTarget; seq: number; at: number } | null> =
  signal<{ target: FocusTarget; seq: number; at: number } | null>(null);
let focusSeq = 0;
const FOCUS_REQUEST_TTL_MS = 1000;

export function requestFocus(target: FocusTarget): void {
  focusRequest.value = { target, seq: ++focusSeq, at: Date.now() };
}
export const focusChatInput = (): void => requestFocus('chat');
export const focusSearchInput = (): void => requestFocus('search');

/**
 * Views call this with their input getter. The request is consumed synchronously in a layout effect,
 * on mount (the view was just navigated to) or when a new request arrives (view already open).
 * Stale requests (older than 1 s, e.g. for a view that never consumed them) are ignored.
 */
export function useFocusRequest(target: FocusTarget, getEl: () => HTMLElement | null): void {
  void focusRequest.value; // subscribes the component to new requests
  // No dependency list: re-checked after every render until consumed or expired.
  useLayoutEffect(() => {
    const r = focusRequest.peek();
    if (!r || r.target !== target) return;
    if (Date.now() - r.at > FOCUS_REQUEST_TTL_MS) { focusRequest.value = null; return; }
    const el = getEl();
    if (el) { el.focus(); focusRequest.value = null; }
  });
}
