import { LIMITS } from '../../shared/api.ts';
import type { AnswerCaptureRequest, CapturesListResponse } from '../../shared/api.ts';
import type { Capture, CaptureQuestion, Id, SourceRef } from '../../shared/types.ts';
import type { DocRef } from '../lib/nav.ts';

// Pure helpers for the conversation stream and the composer. No DOM, no signals.
// Moved from v0.1 `views/chat-logic.ts`; letter-key helpers are gone (v0.2 has no single-letter commands).

/** The two API methods the stream needs; the real `api` object satisfies it, tests pass a mock. */
export interface CaptureApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export const CAPTURE_PAGE = 50;

// ---- capture paging / merging -------------------------------------------------------------

export function capturesPath(before?: Id): string {
  return before === undefined ? `/api/captures?limit=${CAPTURE_PAGE}` : `/api/captures?limit=${CAPTURE_PAGE}&before=${before}`;
}

/** One page of the stream (oldest first). `hasMore` = the page was full, so older ones may exist. */
export async function loadCaptures(api: CaptureApi, before?: Id): Promise<{ captures: Capture[]; hasMore: boolean }> {
  const r = await api.get<CapturesListResponse>(capturesPath(before));
  return { captures: r.captures, hasMore: r.captures.length >= CAPTURE_PAGE };
}

/** Replace the capture with the same id, or append it. Never mutates the input. */
export function upsertCapture(list: Capture[], c: Capture): Capture[] {
  const i = list.findIndex((x) => x.id === c.id);
  if (i < 0) return [...list, c];
  const next = list.slice();
  next[i] = c;
  return next;
}

/**
 * A capture that landed from a send, put into the list. Never downgrades: a stale `asked` copy (waiting in the
 * landed feed while its answer already arrived) must not replace the `answered` capture.
 */
export function upsertLanded(list: Capture[], c: Capture): Capture[] {
  const have = list.find((x) => x.id === c.id);
  if (have?.status === 'answered' && c.status === 'asked') return list;
  return upsertCapture(list, c);
}

/** Older page in front of the current list, skipping ids already present. */
export function prependPage(list: Capture[], older: Capture[]): Capture[] {
  const have = new Set(list.map((c) => c.id));
  return [...older.filter((c) => !have.has(c.id)), ...list];
}

/**
 * The freshly loaded newest page combined with what the stream already holds (captures that landed while
 * the GET was in flight, or from an earlier mount): the loaded copy wins for ids it has, everything else
 * is kept, and the result is ordered by id.
 */
export function mergeLoaded(loaded: Capture[], current: Capture[]): Capture[] {
  const byId = new Map<Id, Capture>();
  for (const c of current) byId.set(c.id, c);
  for (const c of loaded) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

// ---- questions ----------------------------------------------------------------------------

/** Server-supplied answer tokens are only used when they are a single letter or digit. */
const TOKEN = /^[\p{L}\p{N}]$/u;

export function questionPrompt(q: CaptureQuestion): string {
  switch (q.type) {
    case 'kind': return 'What is this?';
    case 'unknown_person': return `I don't know a person called "${q.name}".`;
    case 'ambiguous_person': return `Which "${q.name}" do you mean?`;
    case 'needs_person': return 'Which person is this agenda item for?';
    case 'unknown_project': return `I don't know a project called "${q.name}".`;
    case 'ambiguous_project': return `Which project is "${q.name}"?`;
  }
}

/** Options to render for a question, candidates (1..9) first. */
export function questionChoices(q: CaptureQuestion): { key: string; label: string }[] {
  const cands =
    q.type === 'ambiguous_person' ? q.candidates.map((c) => ({ key: c.key, label: c.name }))
    : q.type === 'ambiguous_project' ? q.candidates.map((c) => ({ key: c.key, label: c.title }))
    : [];
  return [...cands, ...q.options];
}

// ---- reply and chips ----------------------------------------------------------------------

export type ReplyTone =
  | 'filed' | 'pending' | 'ready' | 'undone' | 'discarded' | 'deleted'
  | 'asking' | 'asked' | 'failed' | 'answer' | 'nomatch' | 'removed';
/** A piece of the reply text; with `ref` it is a link that opens the document. */
export interface Seg { text: string; ref?: DocRef }
export interface Reply { tone: ReplyTone; segments: Seg[] }

/** What the reply may link to. A lookup that returns null means "not known": the name is plain text then. */
export interface Lookups {
  personName(id: Id): string | null;
  projectTitle(id: Id): string | null;
  /** The user undid this capture in this session (the server's redacted form cannot tell undone from deleted). */
  undone?(id: Id): boolean;
  /** The client-side state of a question being answered (not stored on the server). */
  ask?(id: Id): AskState | undefined;
}

// ---- question answering (client state) ----------------------------------------------------

/** The server's fixed answer when nothing in the user's data matched (no LLM call was made). */
export const NO_MATCH_TEXT = 'Nothing in your data matches that.';

export type AskFailure = 'failed' | 'no_llm' | 'rate_limited' | 'busy' | 'gone' | 'network' | 'other';
/** `asking`: the ask request is in flight. `failed`: it ended without an answer; the capture stays `asked`. */
export type AskState = { phase: 'asking' } | { phase: 'failed'; failure: AskFailure; retryAfter: number | null };

/** Classify a failed `ask` request (an ApiError, matched structurally so this file stays free of the API client). */
export function askFailureOf(err: unknown): AskState & { phase: 'failed' } {
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number' ? err.status : -1;
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : '';
  const ra = typeof err === 'object' && err !== null && 'retryAfter' in err && typeof err.retryAfter === 'number' ? err.retryAfter : null;
  let failure: AskFailure = 'other';
  if (status === 0) failure = 'network';
  else if (status === 502) failure = 'failed';
  else if (status === 503) failure = 'no_llm';
  else if (status === 429) failure = code === 'busy' ? 'busy' : 'rate_limited';
  else if (status === 404 || status === 409) failure = 'gone';
  return { phase: 'failed', failure, retryAfter: ra };
}

export function askFailureMessage(s: AskState & { phase: 'failed' }): string {
  const wait = s.retryAfter !== null && s.retryAfter > 0 ? ` Try again in ${s.retryAfter} s.` : ' Try again in a moment.';
  switch (s.failure) {
    case 'failed': return 'Could not get an answer just now. The question is still here: try again, file it instead, or discard it.';
    case 'no_llm': return 'Answering questions is not set up on this server. You can file this instead.';
    case 'rate_limited': return `Too many questions in a short time.${wait}`;
    case 'busy': return `XO is busy with other questions.${wait}`;
    case 'gone': return 'This question is no longer waiting for an answer.';
    case 'network': return 'Could not reach the server. Try again.';
    case 'other': return 'Could not get an answer. Try again.';
  }
}

const REDACTED_TEXT = 'This answer was removed because something it used has been deleted.';

const validId = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

function personSeg(c: Capture, l: Lookups): Seg | null {
  const id = c.draft.personId;
  if (id === null || !validId(id)) return null;
  const created = c.filed.some((r) => r.kind === 'person' && r.id === id);
  const suffix = created ? ' (new)' : '';
  const known = l.personName(id);
  if (known !== null) return { text: known + suffix, ref: { kind: 'person', id } };
  const typed = c.draft.personName;
  return typed ? { text: typed + suffix } : null; // never link an id we cannot name
}

function projectSeg(c: Capture, l: Lookups): Seg | null {
  const id = c.draft.projectId;
  if (id === null || !validId(id)) return null;
  const title = l.projectTitle(id);
  if (title === null) return null;
  const created = c.filed.some((r) => r.kind === 'project' && r.id === id);
  return { text: title + (created ? ' (new)' : ''), ref: { kind: 'project', id } };
}

function filedReply(c: Capture, l: Lookups): Seg[] {
  const person = personSeg(c, l);
  const project = projectSeg(c, l);
  const onProject: Seg[] = project ? [{ text: ' · on ' }, project] : [];
  switch (c.draft.kind) {
    case 'note':
      return [{ text: 'Saved as a note' }, ...(person ? [{ text: ' · ' }, person] : []), ...onProject];
    case 'action':
      if (c.draft.owner === 'them') {
        return [...(person ? [{ text: 'Waiting on ' }, person, { text: ' for this' }] : [{ text: 'Waiting for someone on this' }]), ...onProject];
      }
      return [{ text: 'Filed as a task for you' }, ...(person ? [{ text: ' · ' }, person] : []), ...onProject];
    case 'agenda':
      return person ? [{ text: 'Added to ' }, person, { text: "'s 1-1 agenda" }] : [{ text: 'Added to a 1-1 agenda' }];
    default:
      return [{ text: 'Filed' }];
  }
}

/**
 * XO's reply to a capture, composed on the client from the structured fields (the server's `summary` is never
 * shown for filed items: it may carry text the user typed). Never throws; unknown ids give plain text.
 */
export function replyFor(c: Capture, l: Lookups): Reply {
  if (c.deleted === true) {
    return l.undone?.(c.id) ? { tone: 'undone', segments: [{ text: 'Undone' }] } : { tone: 'deleted', segments: [{ text: 'Deleted' }] };
  }
  switch (c.status) {
    case 'filed': return { tone: 'filed', segments: filedReply(c, l) };
    case 'undone': return { tone: 'undone', segments: [{ text: 'Undone' }] };
    case 'discarded': return { tone: 'discarded', segments: [{ text: 'Discarded' }] };
    case 'pending':
      return c.question
        ? { tone: 'pending', segments: [{ text: questionPrompt(c.question) }] }
        : { tone: 'ready', segments: [{ text: 'Ready to file' }] };
    case 'asked': return askedReply(c, l);
    case 'answered': return answeredReply(c);
  }
}

function askedReply(c: Capture, l: Lookups): Reply {
  const st = l.ask?.(c.id);
  if (st?.phase === 'asking') return { tone: 'asking', segments: [{ text: 'Looking through your data…' }] };
  if (st?.phase === 'failed') return { tone: 'failed', segments: [{ text: askFailureMessage(st) }] };
  return { tone: 'asked', segments: [{ text: 'This question has not been answered yet.' }] };
}

/** The answer is plain text (never markup). Redacted and no-match answers are their own states. */
function answeredReply(c: Capture): Reply {
  const a = c.answer;
  if (a === null || a.redacted) return { tone: 'removed', segments: [{ text: REDACTED_TEXT }] };
  if (a.sources.length === 0 && a.text === NO_MATCH_TEXT) return { tone: 'nomatch', segments: [{ text: NO_MATCH_TEXT }] };
  return { tone: 'answer', segments: [{ text: a.text }] };
}

/** The text of a reply as one string (used for tests and screen-reader labels). */
export function replyText(r: Reply): string { return r.segments.map((s) => s.text).join(''); }

export type ChipKind = 'open' | 'undo' | 'reclassify' | 'answer' | 'pick' | 'ask' | 'source';
export interface ChipSpec {
  id: string;
  label: string;
  kind: ChipKind;
  /** For `answer`: the request body. */
  answer?: AnswerCaptureRequest;
  /** For `pick`: which picker to open; the pick then answers `{ personId }` or `{ projectId }`. */
  pickKind?: 'person' | 'project';
  /** For `source`: the document the answer used. */
  ref?: DocRef;
}

const cap = (s: string): string => (s === '' ? s : s[0]!.toUpperCase() + s.slice(1));

/** Where "Open" goes: the filed note, the person, or (action/agenda) the actions list / the person's page. */
export function openRef(c: Capture): DocRef | null {
  if (c.status !== 'filed' || c.deleted === true) return null;
  const personRef = c.filed.find((r) => r.kind === 'person' && validId(r.id));
  for (const r of c.filed) {
    if (!validId(r.id)) continue;
    if (r.kind === 'note') return { kind: 'note', id: r.id };
    if (r.kind === 'action') return { kind: 'actions' };
    if (r.kind === 'agenda') {
      const pid = c.draft.personId ?? personRef?.id ?? null;
      return pid !== null && validId(pid) ? { kind: 'person', id: pid } : null;
    }
  }
  return personRef ? { kind: 'person', id: personRef.id } : null;
}

/**
 * The action chips of a capture, in display order. Filed: Open (only when there is somewhere to go), Undo,
 * Reclassify. Pending with a question: its choices. Pending without a question (a server-side re-derivation
 * found nothing left to ask): File and Discard, which the server accepts as `s` and `d`.
 */
export function chipsFor(c: Capture, ask?: AskState): ChipSpec[] {
  if (c.deleted === true) return [];
  switch (c.status) {
    case 'filed':
      return [
        ...(openRef(c) ? [{ id: 'open', label: 'Open', kind: 'open' as const }] : []),
        { id: 'undo', label: 'Undo', kind: 'undo' },
        { id: 'reclassify', label: 'Reclassify', kind: 'reclassify' },
      ];
    case 'asked':
      return askedChips(ask);
    case 'answered':
      return [...sourceChips(c), { id: 'discard', label: 'Delete answer', kind: 'undo' }];
    case 'undone':
    case 'discarded':
      return [];
    case 'pending':
      return pendingChips(c);
  }
}

/** Answer (Retry after a failure), File instead (reclassify: back to the kind question), Discard. None while asking. */
function askedChips(ask: AskState | undefined): ChipSpec[] {
  if (ask?.phase === 'asking') return [];
  const failed = ask?.phase === 'failed';
  return [
    ...(failed && ask.failure === 'gone' ? [] : [{ id: 'ask', label: failed ? 'Retry' : 'Answer', kind: 'ask' as const }]),
    { id: 'reclassify', label: 'File instead', kind: 'reclassify' },
    { id: 'discard', label: 'Discard', kind: 'undo' },
  ];
}

const SOURCE_TITLE_MAX = 60;

/** Where a source of an answer opens. Actions have no page of their own and agenda items live on a person's page we cannot name. */
export function sourceRef(s: SourceRef): DocRef | null {
  if (!validId(s.id)) return null;
  switch (s.kind) {
    case 'note': return { kind: 'note', id: s.id };
    case 'person': return { kind: 'person', id: s.id };
    case 'project': return { kind: 'project', id: s.id };
    case 'meeting': return { kind: 'meeting', id: s.id };
    case 'action': return { kind: 'actions' };
    case 'agenda': return { kind: 'people' };
  }
}

export function sourceLabel(s: SourceRef): string {
  const t = Array.from(s.title.trim());
  const title = t.length === 0 ? `(${s.kind})` : t.length > SOURCE_TITLE_MAX ? `${t.slice(0, SOURCE_TITLE_MAX - 1).join('')}…` : t.join('');
  return title;
}

/** One chip per cited source (the same document twice shows once). A redacted answer has none. */
export function sourceChips(c: Capture): ChipSpec[] {
  const a = c.answer;
  if (c.status !== 'answered' || a === null || a.redacted) return [];
  const seen = new Set<string>();
  const out: ChipSpec[] = [];
  for (const s of a.sources) {
    const ref = sourceRef(s);
    const id = `src:${s.kind}:${s.id}`;
    if (ref === null || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: sourceLabel(s), kind: 'source', ref });
  }
  return out;
}

function pendingChips(c: Capture): ChipSpec[] {
  const q = c.question;
  if (!q) {
    return [
      { id: 'a:s', label: 'File', kind: 'answer', answer: { key: 's' } },
      { id: 'a:d', label: 'Discard', kind: 'answer', answer: { key: 'd' } },
    ];
  }
  const pickKind: 'person' | 'project' | null =
    q.type === 'unknown_person' || q.type === 'needs_person' ? 'person' : q.type === 'unknown_project' ? 'project' : null;
  const chips: ChipSpec[] = [];
  for (const o of questionChoices(q)) {
    if (!TOKEN.test(o.key)) continue;
    if (o.key === 'p' && pickKind) chips.push({ id: 'pick', label: cap(o.label), kind: 'pick', pickKind });
    else chips.push({ id: `a:${o.key}`, label: cap(o.label), kind: 'answer', answer: { key: o.key } });
  }
  return chips;
}

/**
 * The chip Enter runs when none was moved to: a filed item defaults to Open and an answer to its first source;
 * a question (and an unanswered ask) has NO default (Enter does nothing until one is highlighted).
 */
export function defaultChipId(c: Capture): string | null {
  const chips = chipsFor(c);
  if (chips.some((x) => x.id === 'open')) return 'open';
  return chips.find((x) => x.kind === 'source')?.id ?? null; // an answer: Enter opens its first source
}

// ---- selection stepping -------------------------------------------------------------------

export type Step = { kind: 'select'; id: Id } | { kind: 'older' } | { kind: 'composer' } | { kind: 'none' };

/**
 * Up/Down in the stream. `ids` are the captures, oldest first. Nothing selected: Up picks the newest and
 * Down the composer's neighbour (the newest too). Up at the oldest asks for the previous page (when there
 * is one); Down past the newest returns to the composer.
 */
export function stepSelection(ids: Id[], current: Id | null, dir: 'up' | 'down', hasMore: boolean): Step {
  if (ids.length === 0) return dir === 'down' ? { kind: 'composer' } : { kind: 'none' };
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return { kind: 'select', id: ids[ids.length - 1]! };
  if (dir === 'up') {
    if (i === 0) return hasMore ? { kind: 'older' } : { kind: 'none' };
    return { kind: 'select', id: ids[i - 1]! };
  }
  return i >= ids.length - 1 ? { kind: 'composer' } : { kind: 'select', id: ids[i + 1]! };
}

// ---- send queue ---------------------------------------------------------------------------

export type CaptureSource = 'text' | 'voice';

export interface SendQueueHooks {
  /** A text was accepted. */
  onSent(c: Capture): void;
  /** The server rejected this text (nothing written); it has been removed from the queue. */
  onRejected(text: string, err: unknown, source: CaptureSource): void;
  /** Session or network trouble: everything stays queued, in order. `waiting` = entries left. */
  onTransient(err: unknown, waiting: number): void;
  isTransient(err: unknown): boolean;
}

/**
 * Ordered, one-at-a-time send queue for composer texts. Entries are removed by identity, and `reset()`
 * (logout) bumps a generation: a drain that was running stops after its in-flight request returns and
 * never touches the entries of the new generation (a late response must not delete a newer text).
 * `draining` is keyed to the generation so a new drain is not blocked by an old one.
 * A retry after a status-0 (network) failure may duplicate a capture the server did receive; accepted.
 */
export function createSendQueue() {
  const items: { text: string; source: CaptureSource }[] = [];
  let generation = 0;
  let drainingGen = -1;
  return {
    push(text: string, source: CaptureSource = 'text'): void { items.push({ text, source }); },
    size: () => items.length,
    /** A drain of the current generation is running (a request may be in flight). */
    isDraining: () => drainingGen === generation,
    texts: () => items.map((e) => e.text),
    reset(): void { items.length = 0; generation++; },
    async drain(send: (text: string, source: CaptureSource) => Promise<Capture>, h: SendQueueHooks): Promise<void> {
      const gen = generation;
      if (drainingGen === gen) return;
      drainingGen = gen;
      const remove = (entry: { text: string; source: CaptureSource }) => { const i = items.indexOf(entry); if (i >= 0) items.splice(i, 1); };
      try {
        while (gen === generation && items.length > 0) {
          const entry = items[0]!;
          let c: Capture;
          try {
            c = await send(entry.text, entry.source);
          } catch (err) {
            if (gen !== generation) return;
            if (h.isTransient(err)) { h.onTransient(err, items.length); return; }
            remove(entry);
            h.onRejected(entry.text, err, entry.source);
            continue;
          }
          if (gen !== generation) return;
          remove(entry);
          h.onSent(c);
        }
      } finally {
        if (drainingGen === gen) drainingGen = -1;
      }
    },
  };
}

// ---- landed captures (Stream remount) -----------------------------------------------------

/**
 * Results of sends that completed, kept at module level next to the shared send queue so that whichever
 * Stream is mounted when a send lands (the one that started it may be gone) can pick them up. Each entry
 * remembers the session epoch it was sent in; `take` drops entries from an earlier session.
 */
export function createLandedFeed() {
  let items: { capture: Capture; epoch: number }[] = [];
  return {
    push(capture: Capture, epoch: number): void { items.push({ capture, epoch }); },
    /** Everything that landed in session `epoch`, oldest first; empties the feed. */
    take(epoch: number): Capture[] {
      const out = items.filter((i) => i.epoch === epoch).map((i) => i.capture);
      items = [];
      return out;
    },
    clear(): void { items = []; },
    size: () => items.length,
  };
}

// ---- input history (Option-Up/Down recall) ------------------------------------------------

/** Texts the user can recall, oldest first (deleted captures have no text). */
export function historyTexts(captures: Capture[]): string[] {
  return captures.map((c) => c.text).filter((t) => t !== '');
}

/** Step through history. `cursor === texts.length` means "not recalling"; going down past the end gives ''. */
export function recallStep(texts: string[], cursor: number, dir: 'up' | 'down'): { cursor: number; text: string } {
  if (texts.length === 0) return { cursor: 0, text: '' };
  const start = Math.min(Math.max(cursor, 0), texts.length);
  const next = dir === 'up' ? Math.max(start - 1, 0) : Math.min(start + 1, texts.length);
  return { cursor: next, text: texts[next] ?? '' };
}

/** Where history recall stands: the entry shown and its position in the history. */
export interface RecallPos { cursor: number; text: string }
/** Text typed before recall replaced it (kept in the store, see `chatStash`). */
export interface Stash { text: string; source: 'text' | 'voice' }
export interface RecallResult {
  /** null = not recalling (the draft is the restored stash or empty). */
  pos: RecallPos | null;
  /** The new input text and where it came from. */
  text: string; source: 'text' | 'voice';
  stash: Stash | null;
}

/**
 * Option-Up / Option-Down in the composer, from an empty or a non-empty line.
 * - Fresh typing (no recall in progress and no stash yet) is stashed, never lost.
 * - Once a stash exists it stays, whatever happens to the recalled line: editing a recalled line never
 *   overwrites it. It comes back (with its source) when stepping down past the newest entry.
 * - `pos` is only the position in this Composer; after a remount it is null while the stash survives.
 */
export function recallNext(
  texts: string[], pos: RecallPos | null, draft: string, draftSource: 'text' | 'voice', stash: Stash | null, dir: 'up' | 'down',
): RecallResult {
  const recalling = pos !== null && draft === pos.text;
  const st = stash ?? (!recalling && draft !== '' ? { text: draft, source: draftSource } : null);
  const step = recallStep(texts, recalling ? pos.cursor : texts.length, dir);
  if (step.cursor >= texts.length) {
    return st
      ? { pos: null, text: st.text, source: st.source, stash: null }
      : { pos: null, text: '', source: 'text', stash: null };
  }
  return { pos: { cursor: step.cursor, text: step.text }, text: step.text, source: 'text', stash: st };
}

// ---- composer keys ------------------------------------------------------------------------

export type ComposerKey = 'send' | 'recall-older' | 'recall-newer' | 'to-stream' | 'ignore' | 'native';

export interface ComposerKeyEvent {
  key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; repeat?: boolean;
  isComposing?: boolean; keyCode?: number;
}

/**
 * What a key does in the composer textarea.
 * - Enter sends; Shift-Enter is a newline (native). An IME composition, or Enter with Cmd/Ctrl, is native. A held
 *   Enter (`repeat`) does nothing, and neither does Enter behind an open overlay (the key is swallowed, no newline).
 * - Option-Up / Option-Down recall earlier / later texts (empty or not).
 * - Plain Up in an empty composer moves into the stream when there is something there; otherwise native.
 * - Everything else (plain Down, Up with text, Left/Right, Shift/Ctrl/Cmd arrows) keeps native caret behaviour.
 */
export function composerKey(
  e: ComposerKeyEvent, ctx: { draft: string; hasCaptures: boolean; modalOpen: boolean },
): ComposerKey {
  if (e.isComposing || e.keyCode === 229) return 'native';
  if (e.key === 'Enter') {
    if (ctx.modalOpen || e.repeat) return 'ignore';
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return 'native';
    return 'send';
  }
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return 'native';
  if (ctx.modalOpen || e.shiftKey || e.ctrlKey || e.metaKey) return 'native';
  if (e.altKey) return e.key === 'ArrowUp' ? 'recall-older' : 'recall-newer';
  if (e.key === 'ArrowUp' && ctx.draft === '' && ctx.hasCaptures) return 'to-stream';
  return 'native';
}

/** Characters as the server counts them (code points). */
export function countChars(text: string): number {
  return Array.from(text).length;
}

export interface CounterState { show: boolean; over: boolean; text: string }
/** The length counter appears once the text is within 10 % of the limit and turns to an error above it. */
export function counterState(text: string, limit: number = LIMITS.captureText): CounterState {
  const n = text.length >= limit * 0.9 ? countChars(text) : 0; // cheap exit for the common short case
  const over = n > limit;
  return { show: n >= limit * 0.9, over, text: `${n} / ${limit}` };
}
