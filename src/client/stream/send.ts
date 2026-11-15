import { effect, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { Capture, Id } from '../../shared/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { editChatDraft, epoch, errorText, flash, personName, prependChatDraft, projectTitle, refreshPeople, refreshProjects, session, shellActive, takeChatStash } from '../lib/store.ts';
import { askFailureOf, createLandedFeed, createSendQueue, upsertCapture } from './stream-logic.ts';
import type { AskState, CaptureSource, SendQueueHooks } from './stream-logic.ts';

// Module-level send queue and landed feed. They outlive the Stream and Composer components on purpose: a
// 401 unmounts both (the Login screen covers the shell), and what the user typed must still be sent after
// the next login. Rules (CLAUDE.md lessons):
//  - a second submit is queued, never dropped; entries are removed by identity;
//  - a 401 keeps the queue; only logout (`shellActive` false) resets it (and bumps the queue generation);
//  - results that landed are held for whichever Stream is mounted, and cleared when the session ends;
//  - a text the server rejects goes back into the composer draft with an error, never silently lost.

export const sendQueue = createSendQueue();
export const landed = createLandedFeed();

/** Bumped when a send lands; the mounted Stream takes the feed then. */
export const landedVersion: Signal<number> = signal(0);
/** Texts still waiting to be sent (shown in the stream as "waiting"). */
export const queuedTexts: Signal<string[]> = signal<string[]>([]);
/** A drain is running: the head of the queue is being sent right now. */
export const sending: Signal<boolean> = signal(false);
/** Captures shown in the stream. Server data: cleared when the session ends. */
export const streamCaptures: Signal<Capture[]> = signal<Capture[]>([]);
/** Captures the user undid in this session (the server's redacted form cannot tell undone from deleted). */
export const undoneHere: Set<Id> = new Set();

/**
 * Questions being answered or that failed to be, by capture id. Client-only state (the server only knows
 * `asked`): cleared when the session ends, so a failure never outlives the session it happened in.
 */
export const askStates: Signal<ReadonlyMap<Id, AskState>> = signal<ReadonlyMap<Id, AskState>>(new Map());
const asksInFlight = new Set<Id>();
/** Bumped when an ask finds the capture changed on the server (404/409): the mounted Stream reloads. */
export const reloadVersion: Signal<number> = signal(0);

function setAsk(id: Id, st: AskState | null): void {
  const next = new Map(askStates.peek());
  if (st === null) next.delete(id); else next.set(id, st);
  askStates.value = next;
}

/**
 * Ask the server to answer a question capture (`POST /captures/:id/ask`, which sends the relevant excerpts of the
 * user's data to the LLM). Called ONLY from user-driven paths: a send that landed as `asked`, an answer that made
 * the capture `asked`, and the Answer / Retry chip. Never from loading or reloading the stream. Guard first
 * (one request per capture), epoch-checked after the await: a result from an earlier session is dropped.
 */
export async function askQuestion(id: Id): Promise<void> {
  if (asksInFlight.has(id) || session.peek() === null) return;
  asksInFlight.add(id);
  const e = epoch();
  setAsk(id, { phase: 'asking' });
  try {
    const c = await api.post<Capture>(`/api/captures/${Math.trunc(id)}/ask`);
    if (e !== epoch()) return;
    streamCaptures.value = upsertCapture(streamCaptures.peek(), c);
    setAsk(id, null);
  } catch (err) {
    if (e !== epoch()) return;
    const failed = askFailureOf(err);
    if (failed.failure === 'gone') { setAsk(id, null); reloadVersion.value++; } else setAsk(id, failed);
  } finally {
    asksInFlight.delete(id);
  }
}

function syncQueued(): void { queuedTexts.value = sendQueue.texts(); }

/** Session trouble or a failure that may pass: the text stays queued. Everything else is a rejection. */
export function isTransient(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 401 || err.status === 429 || err.status >= 500;
}

let sendEpoch = 0; // the session epoch of the request in flight (sends are strictly one at a time)

async function sendOne(text: string, source: CaptureSource): Promise<Capture> {
  sendEpoch = epoch();
  return api.post<Capture>('/api/captures', { text, source });
}

/** A person or project created by a capture is not in the store's lists yet: reload them so names resolve to links. */
export function refreshLinks(c: Capture): void {
  // Also a link to an existing one the lists have not seen (created in another tab or by an API call).
  const d = c.draft;
  if (c.filed.some((r) => r.kind === 'person') || (c.status === 'filed' && d.personId !== null && personName(d.personId) === null)) void refreshPeople();
  if (c.filed.some((r) => r.kind === 'project') || (c.status === 'filed' && d.projectId !== null && projectTitle(d.projectId) === null)) void refreshProjects();
}

const hooks: SendQueueHooks = {
  isTransient,
  onSent(c) {
    landed.push(c, sendEpoch);
    syncQueued();
    landedVersion.value++;
    refreshLinks(c);
    // A question that was just sent is answered now (this is the send path; loading never does this).
    if (c.status === 'asked' && sendEpoch === epoch()) void askQuestion(c.id);
  },
  onRejected(text, err, source) {
    syncQueued();
    prependChatDraft(text, source); // typed text is never discarded silently
    flash(`Not sent: ${errorText(err)}`, 'error');
  },
  onTransient(err, waiting) {
    syncQueued();
    // A 401 is shown by the Login screen; the queue is sent after the next login.
    if (err instanceof ApiError && err.status === 401) return;
    flash(`Could not send. ${waiting === 1 ? '1 message is' : `${waiting} messages are`} waiting.`, 'error', {
      action: { label: 'retry', run: () => { void drainQueue(); } },
    });
  },
};

/** Send what is queued, in order, one request at a time. Safe to call at any time (a running drain wins). */
export async function drainQueue(): Promise<void> {
  const p = sendQueue.drain(sendOne, hooks);
  sending.value = sendQueue.isDraining(); // the synchronous part of drain has already marked itself running
  try { await p; } finally { sending.value = sendQueue.isDraining(); }
}

/** Queue a text and start sending. The caller has already taken the text out of the composer. */
export function submitText(text: string, source: CaptureSource): Promise<void> {
  sendQueue.push(text, source);
  syncQueued();
  return drainQueue();
}

/**
 * Enter in the composer: take the draft (trimmed) and send it. The recall stash, if any, is put back as the new
 * draft. Returns false when there was nothing to send.
 */
export function sendDraft(draft: string, source: CaptureSource): boolean {
  const text = draft.trim();
  if (text === '') return false;
  editChatDraft('');
  takeChatStash();
  void submitText(text, source);
  return true;
}

// Session effects. A 401 (session null) clears what came from the server and keeps what the user typed; logout
// (shellActive false) also resets the queue.
effect(() => {
  if (session.value === null) {
    landed.clear();
    streamCaptures.value = [];
    undoneHere.clear();
    askStates.value = new Map();
  }
});
effect(() => {
  if (!shellActive.value) {
    sendQueue.reset();
    landed.clear();
    queuedTexts.value = [];
    sending.value = false;
    streamCaptures.value = [];
    undoneHere.clear();
    askStates.value = new Map();
  }
});
// After the next login, whatever was queued during the 401 goes out. Deferred: the drain must not subscribe this
// effect to the signals the API client reads.
effect(() => {
  if (session.value !== null && sendQueue.size() > 0) void Promise.resolve().then(drainQueue);
});
