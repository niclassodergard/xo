import { clearPendingFocus } from './focus.ts';
import { computed, effect, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useLayoutEffect } from 'preact/hooks';
import type { Id, Person } from '../../shared/types.ts';
import type { NavResponse, PeopleListResponse, ProjectsListResponse, ProjectSummary, SessionResponse } from '../../shared/api.ts';
import { api, ApiError } from './api.ts';
import { modalOpen } from './keys.ts';
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
 *    shell, and the stream and the panel are unmounted (appPhase() === 'locked'), so no server-loaded
 *    content stays in the DOM behind the curtain; `people`, `projects` and `nav` are cleared. What
 *    survives is only what the user typed, held in signals: chatDraft, searchQuery and `drafts` (unsaved
 *    TextEdit text, keyed by the editor's stable `id`), plus the module-level send queue.
 *    Give every TextEdit that edits server data a stable `id`. After re-login the documents remount,
 *    reload, and TextEdit re-applies and retries its pending draft. Component state is NOT preserved,
 *    so anything the user typed must live in one of those signals. Only an explicit logout() wipes drafts.
 * 3. Overlays register a 'modal' key layer (see lib/keys.ts) so keys never reach views behind them.
 *    Focus an overlay's input synchronously (useLayoutEffect / ref callback), never in useEffect.
 * 4. To focus the composer or the panel from outside, call focusTarget('composer' | 'panel') (lib/focus.ts).
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
/** Project list for pickers, labels and the palette. Cleared when the session ends. */
export const projects: Signal<ProjectSummary[]> = signal<ProjectSummary[]>([]);
/** Pinned and recent items for the sidebar. Cleared when the session ends. */
export const nav: Signal<NavResponse> = signal<NavResponse>({ pinned: [], recents: [] });
/** Title shown in the panel header; documents set it with usePanelTitle(). */
export const panelTitle: Signal<string> = signal('');
/** Name of a person by id from the loaded list; null when unknown (never throws). */
export function personName(id: Id | null): string | null {
  return id === null ? null : people.value.find((p) => p.id === id)?.name ?? null;
}
/** Title of a project by id from the loaded list; null when unknown. */
export function projectTitle(id: Id | null): string | null {
  return id === null ? null : projects.value.find((p) => p.id === id)?.title ?? null;
}
/** Set the panel header title while the calling document is mounted. */
export function usePanelTitle(title: string): void {
  useLayoutEffect(() => {
    panelTitle.value = title;
    return () => { if (panelTitle.peek() === title) panelTitle.value = ''; };
  }, [title]);
}
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
export interface PickRequest { kind: 'person' | 'project'; onPick: (id: Id) => void }
export interface PromptRequest { label: string; onSubmit: (value: string) => void }
export interface ConfirmRequest { message: string; onYes: () => void }
/** Store-driven overlays, rendered once by app.tsx. Components may also render <ItemPicker /> themselves. */
export const pickRequest: Signal<PickRequest | null> = signal<PickRequest | null>(null);
export const promptRequest: Signal<PromptRequest | null> = signal<PromptRequest | null>(null);
export const confirmRequest: Signal<ConfirmRequest | null> = signal<ConfirmRequest | null>(null);

// ---- session / data -----------------------------------------------------------------------

function closeAllOverlays(): void {
  overlay.value = null;
  pickRequest.value = null;
  promptRequest.value = null;
  confirmRequest.value = null;
}

effect(() => { if (session.value) shellActive.value = true; });
effect(() => { if (chatDraft.value === '') chatVoiceChars.value = 0; });

// Session ended (401, logout, other tab): invalidate in-flight loads, hide data, close overlays.
// Drafts are kept here on purpose (see convention 2); logout() wipes them.
effect(() => {
  if (session.value === null) {
    clearPendingFocus(); // a queued composer/panel focus must not fire behind the lock
    sessionEpoch++;
    people.value = [];
    projects.value = [];
    nav.value = { pinned: [], recents: [] };
    panelTitle.value = '';
    clearFlash();
    closeAllOverlays();
  }
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

export async function refreshProjects(): Promise<void> {
  const e = epoch();
  try {
    const r = await api.get<ProjectsListResponse>('/api/projects');
    if (e !== epoch()) return;
    projects.value = r.projects;
  } catch (err) {
    if (e === epoch()) flash(`Could not load projects: ${errorText(err)}`, 'error');
  }
}

let navSeq = 0;
/** Write `nav` locally (optimistic change or its rollback); any GET already in flight is now stale and dropped. */
export function setNavOptimistic(next: NavResponse): void {
  navSeq++;
  nav.value = next;
}
/** Silent on failure: the sidebar lists just stay as they are. Only the newest request's response is applied. */
export async function refreshNav(): Promise<void> {
  const e = epoch();
  const seq = ++navSeq;
  try {
    const r = await api.get<NavResponse>('/api/nav');
    if (e !== epoch() || seq !== navSeq) return;
    nav.value = r;
  } catch { /* keep what we have */ }
}

/** Wipe everything that belongs to the session, drafts included. */
function endLocally(): void {
  session.value = null;
  shellActive.value = false;
  chatDraft.value = '';
  chatStash.value = null;
  searchQuery.value = '';
  drafts.value = {};
  navigate('/', { replace: true });
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

// ---- overlay controls ---------------------------------------------------------------------

/**
 * Cmd-K does nothing while any other overlay owns the keyboard (a Prompt, a picker, a confirm, the
 * drawer, a recording). Closing them first would throw away what the user is typing, and stacking the
 * palette behind them would send keystrokes to an invisible input; a no-op is always safe.
 */
function otherOverlayOpen(): boolean {
  return modalOpen() || pickRequest.peek() !== null || promptRequest.peek() !== null || confirmRequest.peek() !== null;
}

export function openPalette(): void {
  if (overlay.value === 'palette' || otherOverlayOpen()) return;
  overlay.value = 'palette';
}

export function togglePalette(): void {
  if (overlay.value === 'palette') closeOverlay();
  else openPalette();
}

export function toggleHelp(): void {
  if (overlay.value === 'help') closeOverlay();
  else if (!otherOverlayOpen()) overlay.value = 'help';
}

export function closeOverlay(): void {
  overlay.value = null; // focus goes back to where it was in components/Overlay.tsx
}

/** Open the item picker (person or project). The picker closes itself before calling onPick. */
export function askPick(kind: 'person' | 'project', onPick: (id: Id) => void): void {
  pickRequest.value = { kind, onPick };
}

export function askText(label: string, onSubmit: (value: string) => void): void {
  promptRequest.value = { label, onSubmit };
}

/** Ask a yes/no question; `onYes` runs only on an explicit yes. */
export function askConfirm(message: string, onYes: () => void): void {
  confirmRequest.value = { message, onYes };
}
