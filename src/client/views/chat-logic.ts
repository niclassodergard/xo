import type { AnswerCaptureRequest, CapturesListResponse, SearchHit } from '../../shared/api.ts';
import type { Action, Capture, CaptureQuestion, ChoiceOption, Id } from '../../shared/types.ts';

// Pure helpers for the Step 8 views (Chat, Actions, Notes, People, Search). No DOM, no signals.

/** The two API methods the chat needs; the real `api` object satisfies it, tests pass a mock. */
export interface CaptureApi {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export const CAPTURE_PAGE = 50;

// ---- capture paging / merging -------------------------------------------------------------

export function capturesPath(before?: Id): string {
  return before === undefined ? `/api/captures?limit=${CAPTURE_PAGE}` : `/api/captures?limit=${CAPTURE_PAGE}&before=${before}`;
}

/** One page of the chat log (oldest first). `hasMore` = the page was full, so older ones may exist. */
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

/** Older page in front of the current list, skipping ids already present. */
export function prependPage(list: Capture[], older: Capture[]): Capture[] {
  const have = new Set(list.map((c) => c.id));
  return [...older.filter((c) => !have.has(c.id)), ...list];
}

// ---- questions ----------------------------------------------------------------------------

/** Server-supplied keys are only used as key bindings when they are a single letter or digit. */
const BINDABLE = /^[\p{L}\p{N}]$/u;

/** Every key that answers this question: its options plus (for ambiguous people) the candidates. */
export function questionKeys(q: CaptureQuestion): string[] {
  const keys = q.options.map((o) => o.key);
  if (q.type === 'ambiguous_person') keys.push(...q.candidates.map((c) => c.key));
  return [...new Set(keys.filter((k) => BINDABLE.test(k)))];
}

export type KeyAnswer =
  | { kind: 'answer'; body: AnswerCaptureRequest }
  | { kind: 'pick' };   // open the person picker, then answer with { personId }

/**
 * Map a pressed key to what to send. `p` on the two "pick existing" questions opens the picker
 * (the answer is then `{ personId }`); every other valid key is answered as `{ key }`. null = not a key of this question.
 */
export function answerForKey(q: CaptureQuestion, key: string): KeyAnswer | null {
  if (!questionKeys(q).includes(key)) return null;
  if ((q.type === 'unknown_person' || q.type === 'needs_person') && key === 'p'
    && q.options.some((o) => o.key === 'p')) return { kind: 'pick' };
  return { kind: 'answer', body: { key } };
}

/** The question whose option keys are live: the selected pending capture, else the newest pending one. */
export function questionTarget(captures: Capture[], selectedId: Id | null): Capture | null {
  const sel = selectedId === null ? undefined : captures.find((c) => c.id === selectedId);
  if (sel && sel.status === 'pending' && sel.question) return sel;
  for (let i = captures.length - 1; i >= 0; i--) {
    const c = captures[i]!;
    if (c.status === 'pending' && c.question) return c;
  }
  return null;
}

export function questionPrompt(q: CaptureQuestion): string {
  switch (q.type) {
    case 'kind': return 'What is this?';
    case 'unknown_person': return `Unknown person "${q.name}".`;
    case 'ambiguous_person': return `Which "${q.name}"?`;
    case 'needs_person': return 'Which person is this agenda item for?';
  }
}

export function optionLabel(o: ChoiceOption): string { return `[${o.key}] ${o.label}`; }

/** Options to render for a question, candidates (1..9) first. */
export function questionChoices(q: CaptureQuestion): { key: string; label: string }[] {
  const cands = q.type === 'ambiguous_person' ? q.candidates.map((c) => ({ key: c.key, label: c.name })) : [];
  return [...cands, ...q.options];
}

// ---- result lines -------------------------------------------------------------------------

export type ResultTone = 'filed' | 'pending' | 'undone' | 'discarded' | 'deleted';
export interface ResultLine { tone: ResultTone; text: string; hint: string }

/**
 * `→ Action (me) · Anna: send budget` plus key hints. A filed capture whose items were all deleted comes
 * back from the server with `deleted: true` (never inferred from empty text): shown as a "(deleted)" marker.
 */
export function isDeleted(c: Capture): boolean { return c.deleted === true; }

export function describeResult(c: Capture): ResultLine {
  // The server marks captures whose items were all deleted with `deleted: true` (status 'undone', text blanked).
  if (isDeleted(c)) return { tone: 'deleted', text: '(deleted)', hint: '' };
  switch (c.status) {
    case 'filed':
      return { tone: 'filed', text: `→ ${c.summary}`, hint: '[u] undo  [r] reclassify' };
    case 'undone': return { tone: 'undone', text: '↩ undone', hint: '' };
    case 'discarded': return { tone: 'discarded', text: '✗ discarded', hint: '' };
    case 'pending': return { tone: 'pending', text: c.question ? `? ${questionPrompt(c.question)}` : '… working', hint: '' };
  }
}

/** Where Enter on a capture goes: the filed note, the person, or (action/agenda) the actions list / person. */
export function openTarget(c: Capture): string | null {
  if (c.status !== 'filed') return null;
  const ok = (n: number) => Number.isInteger(n) && n > 0;
  const personRef = c.filed.find((r) => r.kind === 'person' && ok(r.id));
  for (const r of c.filed) {
    if (!ok(r.id)) continue;
    if (r.kind === 'note') return `/notes/${r.id}`;
    if (r.kind === 'action') return '/actions';
    if (r.kind === 'agenda') {
      const pid = c.draft.personId ?? personRef?.id ?? null;
      return pid !== null && ok(pid) ? `/people/${pid}` : null;
    }
  }
  return personRef ? `/people/${personRef.id}` : null;
}

export function filedPerson(c: Capture): boolean { return c.filed.some((r) => r.kind === 'person'); }

/** `u` / `r` target: only the selected capture, and only if it is filed (no fallback to older ones). */
export function filedTarget(captures: Capture[], selectedId: Id | null): Capture | null {
  const sel = selectedId === null ? undefined : captures.find((c) => c.id === selectedId);
  return sel && sel.status === 'filed' && !isDeleted(sel) ? sel : null;
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
 * Ordered, one-at-a-time send queue for chat texts. Entries are removed by identity, and `reset()`
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

// ---- landed captures (Chat remount) -------------------------------------------------------

/**
 * Results of sends that completed, kept at module level next to the shared send queue so that whichever
 * Chat is mounted when a send lands (the one that started it may be gone) can pick them up. Each entry
 * remembers the session epoch it landed in; `take` drops entries from an earlier session.
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

// ---- input history (up/down recall) -------------------------------------------------------

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

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function shortDate(iso: string): string { return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : ''; }

export function oneLine(s: string): string { return s.replace(/\s+/g, ' ').trim(); }

// ---- actions list -------------------------------------------------------------------------

export interface ActionRow { id: Id; action: Action; header: string | null }

/** Flat, group-ordered rows: Mine, Waiting for, then Done (group header on the first row of each group). */
export function groupActions(actions: Action[]): ActionRow[] {
  const groups: { title: string; items: Action[] }[] = [
    { title: 'Mine', items: actions.filter((a) => a.status === 'open' && a.owner === 'me') },
    { title: 'Waiting for', items: actions.filter((a) => a.status === 'open' && a.owner === 'them') },
    { title: 'Done', items: actions.filter((a) => a.status === 'done') },
  ];
  const rows: ActionRow[] = [];
  for (const g of groups) g.items.forEach((a, i) => rows.push({ id: a.id, action: a, header: i === 0 ? `${g.title} (${g.items.length})` : null }));
  return rows;
}

/** Paging cursor for `before=`: the smallest id loaded, or undefined for an empty list. */
export function oldestId(items: { id: Id }[]): Id | undefined {
  let min: Id | undefined;
  for (const it of items) if (min === undefined || it.id < min) min = it.id;
  return min;
}

// ---- search -------------------------------------------------------------------------------

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;

/** The query to send (trimmed), or null when it is too short to search. */
export function searchTerm(q: string): string | null {
  const t = q.trim();
  return [...t].length >= SEARCH_MIN_CHARS ? t : null;
}

/** Where Enter on a hit goes. Agenda hits open their person; null when there is nowhere to go. */
export function hitTarget(hit: SearchHit): string | null {
  const ok = (n: number | null): n is number => n !== null && Number.isInteger(n) && n > 0;
  switch (hit.kind) {
    case 'note': return ok(hit.id) ? `/notes/${hit.id}` : null;
    case 'person': return ok(hit.id) ? `/people/${hit.id}` : null;
    case 'meeting': return ok(hit.id) ? `/meetings/${hit.id}` : null;
    case 'action': return '/actions';
    case 'agenda': return ok(hit.personId) ? `/people/${hit.personId}` : null;
  }
}
