import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import { parseCapture } from '../../shared/capture-syntax.ts';
import type { PersonLike } from '../../shared/people-match.ts';
import { findPeopleInText, resolveMention } from '../../shared/people-match.ts';
import type { Capture, CaptureQuestion, ChoiceOption, Id, ItemKind, ItemRef } from '../../shared/types.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import type { ClassifyOutput } from '../llm/types.ts';
import { createAction, softDeleteAction } from '../repos/actions.ts';
import { createAgendaItem, softDeleteAgendaItem } from '../repos/agenda.ts';
import type { CaptureRecord, StoredDraft } from '../repos/captures.ts';
import {
  getCaptureRecord, insertCapture, listCaptureRecords, liveItemKeys, updateCapture,
} from '../repos/captures.ts';
import { createNote, softDeleteNote } from '../repos/notes.ts';
import { createPerson, getPerson, listPeopleForMatching } from '../repos/people.ts';

export type AnswerResult = Capture | 'not_found' | 'not_pending' | 'bad_answer';
/** `gone`: every item this capture filed was already deleted elsewhere; nothing is returned or changed. */
export type UndoResult = Capture | 'not_found' | 'not_filed' | 'gone';

export interface CaptureService {
  submit(text: string, source: 'text' | 'voice'): Promise<Capture>;
  answer(id: Id, answer: { key: string } | { personId: Id }): Promise<AnswerResult>;
  undo(id: Id): UndoResult;
  reclassify(id: Id): UndoResult;
  list(opts: { limit: number; before?: Id }): Capture[];
}

export interface CaptureServiceOptions {
  /** Classifier deadline (default 15 s). */
  classifyTimeoutMs?: number;
  /** Diagnostics sink. Receives fixed messages and error class names only, never capture text. */
  warn?: (message: string) => void;
}

/** Caps for what is sent to the LLM (names are untrusted, size-bounded data). */
const LLM_MAX_PEOPLE = 200;
const LLM_MAX_ALIASES = 10;
const LLM_MAX_NAME = 100;
const MAX_CANDIDATES = 9;
const SUMMARY_TEXT_MAX = 80;

const KIND_LABEL: Record<ItemKind, string> = { note: 'Note', action: 'Action', agenda: 'Agenda' };
const KIND_KEYS = new Map<string, ItemKind>([['n', 'note'], ['t', 'action'], ['a', 'agenda']]);
const DELETED_MARKER = '(deleted)';

const opt = (key: string, label: string): ChoiceOption => ({ key, label });
const DISCARD = opt('d', 'Discard');

function kindQuestion(): CaptureQuestion {
  return { type: 'kind', options: [opt('n', 'Note'), opt('t', 'Action'), opt('a', 'Agenda item'), DISCARD] };
}

function unknownPersonQuestion(name: string, canSkip: boolean): CaptureQuestion {
  const options = [opt('c', `Create person "${name}"`), opt('p', 'Pick existing person')];
  if (canSkip) options.push(opt('s', 'Skip (no person)'));
  options.push(DISCARD);
  return { type: 'unknown_person', name, options };
}

function ambiguousPersonQuestion(name: string, people: { id: Id; name: string }[], canSkip: boolean): CaptureQuestion {
  const candidates = people.slice(0, MAX_CANDIDATES).map((p, i) => ({ key: String(i + 1), personId: p.id, name: p.name }));
  const options = canSkip ? [opt('s', 'Skip (no person)'), DISCARD] : [DISCARD];
  return { type: 'ambiguous_person', name, candidates, options };
}

function needsPersonQuestion(): CaptureQuestion {
  return { type: 'needs_person', options: [opt('p', 'Pick existing person'), DISCARD] };
}

/** Runs `fn` in one transaction. `fn` must be synchronous: no `await` between BEGIN and COMMIT. */
function inTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('transaction body must be synchronous');
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function toCapture(r: CaptureRecord): Capture {
  const d = r.draft;
  return {
    id: r.id, text: r.text, source: r.source, status: r.status,
    draft: { kind: d.kind, text: d.text, personId: d.personId, personName: d.personName, owner: d.owner },
    question: r.question, filed: r.filed, summary: r.summary, classifiedBy: r.classifiedBy, createdAt: r.createdAt, deleted: false,
  };
}

/** The chat-history form of a capture whose items are all gone: no text, draft or summary. */
function toDeletedCapture(r: CaptureRecord): Capture {
  return {
    id: r.id, text: '', source: r.source, status: 'undone',
    draft: { kind: null, text: '', personId: null, personName: null, owner: 'me' },
    question: null, filed: [], summary: DELETED_MARKER, classifiedBy: null, createdAt: r.createdAt, deleted: true,
  };
}

function foldName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const WARN_NAMES = new Set(['LlmError', 'AbortError', 'TimeoutError']);
function errorClass(e: unknown): string {
  return e instanceof Error && WARN_NAMES.has(e.name) ? e.name : 'Error';
}

/** True when a filed/undone capture has no live item left (or no item refs at all): its text must not be shown. */
function isGone(r: CaptureRecord, live: Set<string>): boolean {
  if (r.status !== 'filed' && r.status !== 'undone') return false;
  const items = r.filed.filter(isItemRef);
  return items.every((i) => !live.has(`${i.kind}:${i.id}`));
}

/** The one place a capture is turned into API form: redacted when its items are gone. */
function present(r: CaptureRecord, live: Set<string>): Capture {
  return isGone(r, live) ? toDeletedCapture(r) : toCapture(r);
}

function isItemRef(r: ItemRef): r is ItemRef & { kind: ItemKind } {
  return r.kind !== 'person';
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > SUMMARY_TEXT_MAX ? `${chars.slice(0, SUMMARY_TEXT_MAX - 1).join('')}…` : flat;
}

function summarize(draft: StoredDraft, personName: string | null, created: boolean): string {
  const kind = draft.kind!;
  const label = kind === 'action' ? `${KIND_LABEL[kind]} (${draft.owner})` : KIND_LABEL[kind];
  const who = personName === null ? '' : ` · ${personName}${created ? ' (new)' : ''}`;
  return `${label}${who}: ${oneLine(draft.text)}`;
}

/** Strict re-validation of classifier output; anything unexpected counts as a failed classification. */
function validateOutput(raw: unknown): ClassifyOutput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'note' && o.kind !== 'action' && o.kind !== 'agenda') return null;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  if (o.owner !== 'me' && o.owner !== 'them') return null;
  if (o.personName !== null && typeof o.personName !== 'string') return null;
  return { kind: o.kind, confidence: o.confidence, owner: o.owner, personName: o.personName };
}

function validName(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const t = name.replace(/\s+/g, ' ').trim();
  // Control characters have no place in a name that may become a person row.
  // eslint-disable-next-line no-control-regex
  if (t === '' || Array.from(t).length > LIMITS.name || /[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

export function createCaptureService(deps: AppDeps, options: CaptureServiceOptions = {}): CaptureService {
  const { db } = deps;
  const timeoutMs = options.classifyTimeoutMs ?? 15_000;
  const warn = options.warn ?? ((): void => {});

  function setMention(draft: StoredDraft, rawName: string, people: PersonLike[], suggested: boolean): void {
    const name = validName(rawName);
    if (name === null) return;
    const found = resolveMention(name, people);
    if (found.length === 1 && !suggested) {
      draft.personId = found[0]!.id;
      draft.personName = found[0]!.name;
    } else {
      // An LLM-suggested person is only a suggestion: it is always confirmed, even when it matches one person.
      draft.suggested = suggested;
      // none: unknown person; several: ambiguous. Either way the user decides.
      draft.personName = name;
      draft.personPending = true;
      draft.candidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
    }
  }

  async function classify(text: string, people: PersonLike[]): Promise<ClassifyOutput | null> {
    const classifier = deps.classifier;
    if (!classifier) return null;
    const input = {
      text,
      people: people.slice(0, LLM_MAX_PEOPLE).map((p) => ({
        name: Array.from(p.name).slice(0, LLM_MAX_NAME).join(''),
        aliases: p.aliases.slice(0, LLM_MAX_ALIASES).map((a) => Array.from(a).slice(0, LLM_MAX_NAME).join('')),
      })),
      now: deps.now().toISOString(),
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // The race enforces the deadline even if the classifier ignores the abort signal.
      const deadline = new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('classifier timeout')), { once: true });
      });
      const out = validateOutput(await Promise.race([classifier.classify(input, ac.signal), deadline]));
      if (out === null) warn('capture classifier returned invalid output');
      return out;
    } catch (e) {
      warn(`capture classifier failed: ${errorClass(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The open person question for a draft, or null. Re-resolves against the current people, so stale state collapses. */
  function personQuestion(draft: StoredDraft, people: PersonLike[]): CaptureQuestion | null {
    if (!draft.personPending) return null;
    const canSkip = draft.kind !== 'agenda';
    let live: PersonLike[];
    if (draft.personName !== null && !draft.suggested) {
      // Explicit @name: who it names may have changed since the question was asked (people created meanwhile).
      live = resolveMention(draft.personName, people);
      draft.candidates = live.slice(0, MAX_CANDIDATES).map((p) => p.id);
    } else {
      const byId = new Map(people.map((p) => [p.id, p]));
      live = draft.candidates.map((id) => byId.get(id)).filter((p): p is PersonLike => p !== undefined);
    }
    if (live.length === 1 && !draft.suggested) {
      draft.personId = live[0]!.id;
      draft.personName = live[0]!.name;
      draft.personPending = false;
      draft.candidates = [];
      return null;
    }
    if (live.length === 0) {
      if (draft.personName === null) {
        draft.personPending = false;
        return null;
      }
      draft.suggested = false;
      return unknownPersonQuestion(draft.personName, canSkip);
    }
    const name = draft.personName ?? live.map((p) => p.name).join(' / ');
    return ambiguousPersonQuestion(name, live, canSkip);
  }

  /** Next question in the order kind, person, needs-person; null when the draft is ready to file. */
  function nextQuestion(draft: StoredDraft, people: PersonLike[] = listPeopleForMatching(db)): CaptureQuestion | null {
    if (draft.kind === null) return kindQuestion();
    const pq = personQuestion(draft, people);
    if (pq) return pq;
    if (draft.kind === 'agenda' && draft.personId === null) return needsPersonQuestion();
    return null;
  }

  /** Writes the item (and a confirmed new person). Call inside a transaction. */
  function fileItems(draft: StoredDraft, createName: string | null, now: Date): { filed: ItemRef[]; summary: string; draft: StoredDraft } {
    const d: StoredDraft = { ...draft, candidates: [], suggested: false };
    const filed: ItemRef[] = [];
    let created = false;
    if (createName !== null) {
      const p = createPerson(db, { name: createName }, now);
      d.personId = p.id;
      d.personName = p.name;
      created = true;
    }
    d.personPending = false;
    let item: ItemRef;
    switch (d.kind) {
      case 'note':
        item = { kind: 'note', id: createNote(db, { bodyMd: d.text, personId: d.personId }, now).id };
        break;
      case 'action':
        item = { kind: 'action', id: createAction(db, { text: d.text, owner: d.owner, personId: d.personId }, now).id };
        break;
      case 'agenda':
        if (d.personId === null) throw new Error('agenda item needs a person');
        item = { kind: 'agenda', id: createAgendaItem(db, { personId: d.personId, text: d.text }, now).id };
        break;
      default:
        throw new Error('draft has no kind');
    }
    filed.push(item);
    if (created) filed.push({ kind: 'person', id: d.personId! });
    return { filed, summary: summarize(d, d.personId === null ? null : d.personName, created), draft: d };
  }

  function softDeleteRefs(refs: ItemRef[], now: Date): void {
    for (const ref of refs) {
      if (!isItemRef(ref)) continue; // a person created by the capture is kept
      // A missing or already deleted item counts as gone.
      if (ref.kind === 'note') softDeleteNote(db, ref.id, now);
      else if (ref.kind === 'action') softDeleteAction(db, ref.id, now);
      else softDeleteAgendaItem(db, ref.id, now);
    }
  }

  type Fields = Pick<CaptureRecord, 'status' | 'draft' | 'question' | 'filed' | 'summary' | 'classifiedBy'>;

  /**
   * Files the draft in one transaction (no await inside), or, if the linked person was archived since
   * the question was asked, drops the link and asks again instead. `persist` writes the capture row.
   */
  function settle(
    draft: StoredDraft, createName: string | null, classifiedBy: Capture['classifiedBy'], now: Date,
    persist: (f: Fields) => CaptureRecord,
  ): CaptureRecord {
    return inTx(db, () => {
      if (createName === null && draft.personId !== null) {
        const p = getPerson(db, draft.personId);
        if (!p || p.archivedAt !== null) {
          // Never re-link by name here: the archived person's name may match someone else. Ask instead.
          const d: StoredDraft = { ...draft, personId: null, candidates: [], suggested: false, personPending: false };
          let question: CaptureQuestion;
          if (d.kind === 'agenda') {
            d.personName = null;
            question = needsPersonQuestion();
          } else {
            const name = p?.name ?? d.personName ?? 'Unknown';
            const others = resolveMention(name, listPeopleForMatching(db)).slice(0, MAX_CANDIDATES);
            d.personName = name;
            d.personPending = true;
            if (others.length === 0) {
              question = unknownPersonQuestion(name, true);
            } else {
              d.suggested = true;
              d.candidates = others.map((o) => o.id);
              question = ambiguousPersonQuestion(name, others, true);
            }
          }
          return persist({ status: 'pending', draft: d, question, filed: [], summary: '', classifiedBy });
        }
      }
      const f = fileItems(draft, createName, now);
      return persist({ status: 'filed', draft: f.draft, question: null, filed: f.filed, summary: f.summary, classifiedBy });
    });
  }

  return {
    async submit(text, source) {
      const parsed = parseCapture(text);
      if (parsed.text === '') throw new HttpError(400, 'validation_error', 'Nothing to capture');
      const people = listPeopleForMatching(db);
      const draft: StoredDraft = {
        kind: parsed.forcedKind, text: parsed.text, personId: null, personName: null,
        owner: parsed.forcedOwner ?? 'me', personPending: false, candidates: [], suggested: false,
      };
      let classifiedBy: Capture['classifiedBy'] = parsed.forcedKind !== null ? 'prefix' : null;

      // Person: an explicit @mention first (only the first one is used), then known names in the text.
      if (parsed.mentions.length > 0) {
        setMention(draft, parsed.mentions[0]!, people, false);
      } else {
        const found = findPeopleInText(parsed.text, people);
        if (found.length === 1) {
          draft.personId = found[0]!.id;
          draft.personName = found[0]!.name;
        } else if (found.length > 1) {
          draft.personPending = true;
          draft.candidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
        }
      }

      // Kind: a prefix forces it; otherwise the LLM decides, but only when confident.
      if (draft.kind === null) {
        const out = await classify(parsed.text, people);
        if (out !== null && out.confidence >= deps.config.classifyThreshold) {
          draft.kind = out.kind;
          draft.owner = out.owner;
          classifiedBy = 'llm';
          // The text scan above found nobody, so an LLM-named person is only a suggestion: always ask.
          if (draft.personId === null && !draft.personPending && out.personName !== null) {
            setMention(draft, out.personName, people, true);
          }
        }
      }

      const now = deps.now();
      const question = nextQuestion(draft, people);
      if (question) {
        return toCapture(insertCapture(db, { text, source, status: 'pending', draft, question, filed: [], summary: '', classifiedBy }, now));
      }
      return toCapture(settle(draft, null, classifiedBy, now, (f) => insertCapture(db, { text, source, ...f }, now)));
    },

    async answer(id, answer) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      if (rec.status !== 'pending') return 'not_pending';
      const people = listPeopleForMatching(db);
      const q = rec.question ?? nextQuestion({ ...rec.draft }, people);
      if (q === null) return 'bad_answer';
      const now = deps.now();
      const draft: StoredDraft = { ...rec.draft };
      let classifiedBy = rec.classifiedBy;
      let discard = false;
      let createName: string | null = null;
      const clearPerson = (): void => {
        draft.personPending = false; draft.candidates = []; draft.personName = null; draft.suggested = false;
      };
      const link = (p: { id: Id; name: string }): void => {
        draft.personId = p.id; draft.personName = p.name; draft.personPending = false; draft.candidates = []; draft.suggested = false;
      };

      const key = 'key' in answer ? answer.key.toLowerCase() : null;
      if (key === 'd') {
        discard = true;
      } else if (!('key' in answer)) {
        // Picking an existing person answers any person question, never the kind question.
        if (q.type === 'kind') return 'bad_answer';
        const p = getPerson(db, answer.personId);
        if (!p || p.archivedAt !== null) return 'bad_answer';
        link(p);
      } else if (q.type === 'kind') {
        const kind = KIND_KEYS.get(key!);
        if (kind === undefined) return 'bad_answer';
        draft.kind = kind;
        classifiedBy = 'user';
      } else if (q.type === 'unknown_person') {
        if (key === 'c') {
          const name = validName(q.name);
          if (name === null) return 'bad_answer';
          // Someone with exactly this name (or alias) may exist by now, e.g. created by an earlier pending
          // capture: never duplicate. A merely similar name ("Lisa Berg" for "Lisa") is not the same person.
          const want = foldName(name);
          const found = people.filter((p) => [p.name, ...p.aliases].some((n) => foldName(n) === want));
          if (found.length === 0) {
            createName = name;
          } else if (found.length === 1) {
            link(found[0]!);
          } else {
            draft.personName = name; draft.personPending = true; draft.suggested = false;
            draft.candidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
          }
        } else if (key === 's' && draft.kind !== 'agenda') {
          clearPerson();
        } else {
          return 'bad_answer'; // includes 'p': the client opens its person picker and sends { personId }
        }
      } else if (q.type === 'ambiguous_person') {
        const cand = q.candidates.find((c) => c.key === key);
        if (cand) {
          const p = getPerson(db, cand.personId);
          if (!p || p.archivedAt !== null) return 'bad_answer';
          link(p);
        } else if (key === 's' && draft.kind !== 'agenda') {
          clearPerson();
        } else {
          return 'bad_answer';
        }
      } else {
        return 'bad_answer'; // needs_person: only 'd' or a personId
      }

      if (discard) {
        return toCapture(updateCapture(db, id, { status: 'discarded', question: null, summary: 'Discarded' }, now)!);
      }
      // Creating a person is only ever offered after the kind is known, so filing follows directly.
      const question = createName !== null ? null : nextQuestion(draft, people);
      if (question) {
        return toCapture(updateCapture(db, id, { draft, question, classifiedBy }, now)!);
      }
      return toCapture(settle(draft, createName, classifiedBy, now, (f) => updateCapture(db, id, f, now)!));
    },

    undo(id) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      if (rec.status !== 'filed') return 'not_filed';
      const now = deps.now();
      return inTx(db, () => {
        const items = rec.filed.filter(isItemRef);
        if (items.length === 0 || liveItemKeys(db, items).size === 0) return 'gone' as const;
        softDeleteRefs(rec.filed, now);
        // Every item is deleted now, so the response is the redacted form, like the list shows it.
        return present(updateCapture(db, id, { status: 'undone', question: null }, now)!, new Set());
      });
    },

    reclassify(id) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      if (rec.status !== 'filed') return 'not_filed';
      const now = deps.now();
      return inTx(db, () => {
        const items = rec.filed.filter(isItemRef);
        if (items.length === 0 || liveItemKeys(db, items).size === 0) return 'gone' as const;
        softDeleteRefs(rec.filed, now);
        // The person link stays (also a person this capture created); `filed` is replaced, never appended to.
        const draft: StoredDraft = { ...rec.draft, kind: null, owner: 'me', personPending: false, candidates: [], suggested: false };
        return toCapture(updateCapture(db, id, {
          status: 'pending', draft, question: kindQuestion(), filed: [], summary: '', classifiedBy: null,
        }, now)!);
      });
    },

    list(opts) {
      const recs = listCaptureRecords(db, opts);
      const refs = recs.filter((r) => r.status === 'filed' || r.status === 'undone').flatMap((r) => r.filed.filter(isItemRef));
      const live = refs.length > 0 ? liveItemKeys(db, refs) : new Set<string>();
      let people: PersonLike[] | null = null;
      return recs.map((r) => {
        // A pending capture with a damaged stored question gets it re-derived, as `answer` does.
        if (r.status === 'pending' && r.question === null) {
          people ??= listPeopleForMatching(db);
          r = { ...r, question: nextQuestion({ ...r.draft }, people) };
        }
        return present(r, live);
      });
    },
  };
}
