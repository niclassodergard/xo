import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import { parseCapture } from '../../shared/capture-syntax.ts';
import type { PersonLike } from '../../shared/people-match.ts';
import { findPeopleInText, resolveMention } from '../../shared/people-match.ts';
import type { ProjectLike } from '../../shared/project-match.ts';
import { findProjectsInText, resolveProjectMention } from '../../shared/project-match.ts';
import type { Capture, CaptureAnswer, CaptureQuestion, ChoiceOption, Id, ItemKind, ItemRef } from '../../shared/types.ts';
import type { AppDeps } from '../deps.ts';
import { HttpError } from '../errors.ts';
import type { ClassifyOutput } from '../llm/types.ts';
import { createAction, softDeleteAction } from '../repos/actions.ts';
import { createAgendaItem, softDeleteAgendaItem } from '../repos/agenda.ts';
import type { CaptureRecord, StoredDraft, StoredRef } from '../repos/captures.ts';
import {
  emptyDraft, getCaptureRecord, insertCapture, listCaptureRecords, liveItemKeys, liveSourceTitles, updateCapture,
} from '../repos/captures.ts';
import { createNote, softDeleteNote } from '../repos/notes.ts';
import { createPerson, getPerson, listPeopleForMatching } from '../repos/people.ts';
import { createProject, getProject, listProjects, listProjectsForMatching } from '../repos/projects.ts';

export type AnswerResult = Capture | 'not_found' | 'not_pending' | 'bad_answer';
/** `gone`: every item this capture filed was already deleted elsewhere; nothing is returned or changed. */
export type UndoResult = Capture | 'not_found' | 'not_filed' | 'gone';

export interface CaptureService {
  submit(text: string, source: 'text' | 'voice'): Promise<Capture>;
  answer(id: Id, answer: { key: string } | { personId: Id } | { projectId: Id }): Promise<AnswerResult>;
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
const LLM_MAX_PROJECTS = 100;
const MAX_CANDIDATES = 9;
const SUMMARY_TEXT_MAX = 80;

const KIND_LABEL: Record<ItemKind | 'question', string> = { note: 'Note', action: 'Action', agenda: 'Agenda', question: 'Question' };
const KIND_KEYS = new Map<string, ItemKind>([['n', 'note'], ['t', 'action'], ['a', 'agenda']]);
const DELETED_MARKER = '(deleted)';

const opt = (key: string, label: string): ChoiceOption => ({ key, label });
const DISCARD = opt('d', 'Discard');

function kindQuestion(): CaptureQuestion {
  return { type: 'kind', options: [opt('n', 'Note'), opt('t', 'Action'), opt('a', 'Agenda item'), opt('q', 'Answer it'), DISCARD] };
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

function unknownProjectQuestion(name: string): CaptureQuestion {
  return {
    type: 'unknown_project', name,
    options: [opt('c', `Create project "${name}"`), opt('p', 'Pick existing project'), opt('s', 'Skip (no project)'), DISCARD],
  };
}

function ambiguousProjectQuestion(name: string, projects: { id: Id; title: string }[]): CaptureQuestion {
  const candidates = projects.slice(0, MAX_CANDIDATES).map((p, i) => ({ key: String(i + 1), projectId: p.id, title: p.title }));
  return { type: 'ambiguous_project', name, candidates, options: [opt('s', 'Skip (no project)'), DISCARD] };
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

function toCapture(r: CaptureRecord, answer: CaptureAnswer | null = null): Capture {
  const d = r.draft;
  return {
    id: r.id, text: r.text, source: r.source, status: r.status,
    draft: {
      kind: d.kind, text: d.text, personId: d.personId, projectId: d.projectId, owner: d.owner,
      // A question shows only resolved links; unresolved names stay in storage for "File instead".
      personName: d.kind === 'question' && d.personId === null ? null : d.personName,
      projectName: d.kind === 'question' && d.projectId === null ? null : d.projectName,
    },
    question: r.question, filed: r.filed, summary: r.summary, classifiedBy: r.classifiedBy, createdAt: r.createdAt, deleted: false, answer,
  };
}

/** The chat-history form of a capture whose items are all gone: no text, draft or summary. */
function toDeletedCapture(r: CaptureRecord): Capture {
  return {
    id: r.id, text: '', source: r.source, status: 'undone',
    draft: { kind: null, text: '', personId: null, personName: null, projectId: null, projectName: null, owner: 'me' },
    question: null, filed: [], summary: DELETED_MARKER, classifiedBy: null, createdAt: r.createdAt, deleted: true, answer: null,
  };
}

/** The lower-cased key of a `{ key }` answer, else null. */
function key0(answer: { key: string } | { personId: Id } | { projectId: Id }): string | null {
  return 'key' in answer ? answer.key.toLowerCase() : null;
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

/** Only these referenced kinds can be deleted; a sent person or meeting never redacts an answer. Explicit allow-list. */
const ERASABLE_SOURCE_KINDS: ReadonlySet<StoredRef['kind']> = new Set(['note', 'action', 'agenda', 'project']);
const REDACTED_ANSWER: CaptureAnswer = { text: '', sources: [], redacted: true };

/**
 * An answer is a derived copy of every excerpt that was sent. If any sent note, action, agenda item or project
 * is deleted or gone, the whole answer is blanked. A damaged stored answer is blanked too (fail closed).
 * `titles` holds the refs that are still alive, with their current title.
 */
function answerView(r: CaptureRecord, titles: Map<string, string>): CaptureAnswer {
  const s = r.sources;
  if (r.answer === null || s === null) return REDACTED_ANSWER;
  if (s.sent.some((x) => ERASABLE_SOURCE_KINDS.has(x.kind) && !titles.has(`${x.kind}:${x.id}`))) return REDACTED_ANSWER;
  const sources = s.cited.flatMap((c) => {
    const title = titles.get(`${c.kind}:${c.id}`);
    return title === undefined ? [] : [{ kind: c.kind, id: c.id, title }];
  });
  return { text: r.answer, sources, redacted: false };
}

/** One capture in API form: redacted when its items are gone (filed) or an item its answer used is gone (answered). */
function present(r: CaptureRecord, live: Set<string>, titles: Map<string, string> = new Map()): Capture {
  if (r.status === 'answered') return toCapture(r, answerView(r, titles));
  return isGone(r, live) ? toDeletedCapture(r) : toCapture(r);
}

/** A page of captures in API form; the liveness lookups are batched over the whole page. */
export function presentRecords(db: DatabaseSync, recs: CaptureRecord[]): Capture[] {
  const items = recs.filter((r) => r.status === 'filed' || r.status === 'undone').flatMap((r) => r.filed.filter(isItemRef));
  const live = items.length > 0 ? liveItemKeys(db, items) : new Set<string>();
  const sources = recs.filter((r) => r.status === 'answered').flatMap((r) => (r.sources ? [...r.sources.sent, ...r.sources.cited] : []));
  const titles = sources.length > 0 ? liveSourceTitles(db, sources) : new Map<string, string>();
  return recs.map((r) => present(r, live, titles));
}

/**
 * The draft of a question. Only the kind changes: any pending person or project question (and what the parser
 * stripped from the text, like `@Anna` or `#Apollo`) stays stored, so "File instead" later asks the normal
 * questions. `toCapture` hides unresolved names from the public draft. `nextQuestion` is never asked for a question.
 */
function questionDraft(d: StoredDraft): StoredDraft {
  return { ...d, kind: 'question' };
}

/** Explicit allow-list: only note, action and agenda refs are items. `person` and `project` refs are kept, never deleted. */
function isItemRef(r: ItemRef): r is ItemRef & { kind: ItemKind } {
  return r.kind === 'note' || r.kind === 'action' || r.kind === 'agenda';
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
  if (o.kind !== 'note' && o.kind !== 'action' && o.kind !== 'agenda' && o.kind !== 'question') return null;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  if (o.owner !== 'me' && o.owner !== 'them') return null;
  if (o.personName !== null && typeof o.personName !== 'string') return null;
  // A classifier that predates projects may omit the key: that means "no project".
  const projectName = o.projectName === undefined ? null : o.projectName;
  if (projectName !== null && typeof projectName !== 'string') return null;
  return { kind: o.kind, confidence: o.confidence, owner: o.owner, personName: o.personName, projectName };
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

  /** Best effort: after an answer was erased, truncate the WAL so the old bytes do not linger in it. */
  function scrubWal(): void {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* the erase itself is committed */ }
  }

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

  const linkProject = (draft: StoredDraft, p: { id: Id; title: string }): void => {
    draft.projectId = p.id; draft.projectName = p.title; draft.projectPending = false;
    draft.projectCandidates = []; draft.projectSuggested = false; draft.projectCreate = null;
  };

  /** Explicit `#mention`: one match links; none is an unknown project; several are ambiguous. Always asks when unsure. */
  function setProjectMention(draft: StoredDraft, rawName: string, projects: ProjectLike[]): void {
    const name = validName(rawName);
    if (name === null) return;
    const found = resolveProjectMention(name, projects);
    if (found.length === 1) {
      linkProject(draft, found[0]!);
    } else {
      draft.projectName = name;
      draft.projectPending = true;
      draft.projectCandidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
    }
  }

  /** The classifier's project name is only a suggestion (it was already vetted, but is checked again here). */
  function suggestProject(draft: StoredDraft, rawName: string, projects: ProjectLike[]): void {
    const name = validName(rawName);
    if (name === null) return;
    const want = foldName(name);
    const found = projects.filter((p) => [p.title, ...p.aliases].some((n) => foldName(n) === want));
    if (found.length === 0) return;
    draft.projectName = name;
    draft.projectPending = true;
    draft.projectSuggested = true;
    draft.projectCandidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
  }

  async function classify(text: string, people: PersonLike[], projects: ProjectLike[]): Promise<ClassifyOutput | null> {
    const classifier = deps.classifier;
    if (!classifier) return null;
    const input = {
      text,
      people: people.slice(0, LLM_MAX_PEOPLE).map((p) => ({
        name: Array.from(p.name).slice(0, LLM_MAX_NAME).join(''),
        aliases: p.aliases.slice(0, LLM_MAX_ALIASES).map((a) => Array.from(a).slice(0, LLM_MAX_NAME).join('')),
      })),
      projects: projects.slice(0, LLM_MAX_PROJECTS).map((p) => ({
        title: Array.from(p.title).slice(0, LLM_MAX_NAME).join(''),
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

  /**
   * The open project question, or null. A project question lists only candidates that are still alive
   * (nothing is re-resolved by name: whatever the user was asked about stays what they are asked about).
   * Agenda items have no project, so they never get one.
   */
  function projectQuestion(draft: StoredDraft): CaptureQuestion | null {
    if (draft.kind === 'agenda' || !draft.projectPending) return null;
    const live = draft.projectCandidates.map((id) => getProject(db, id)).filter((p) => p !== null);
    draft.projectCandidates = live.map((p) => p.id);
    if (live.length > 0) return ambiguousProjectQuestion(draft.projectName ?? live[0]!.title, live);
    if (draft.projectName === null || draft.projectSuggested) {
      draft.projectPending = false; draft.projectSuggested = false; draft.projectName = null;
      return null;
    }
    return unknownProjectQuestion(draft.projectName);
  }

  /** Next question in the order kind, person, needs-person, project; null when the draft is ready to file. */
  function nextQuestion(draft: StoredDraft, people: PersonLike[] = listPeopleForMatching(db)): CaptureQuestion | null {
    if (draft.kind === null) return kindQuestion();
    if (draft.kind === 'question') return null; // a question is never filed: it has its own path
    const pq = personQuestion(draft, people);
    if (pq) return pq;
    if (draft.kind === 'agenda' && draft.personId === null && draft.personCreate === null) return needsPersonQuestion();
    return projectQuestion(draft);
  }

  /**
   * Writes the item, plus the person and project the draft asked to create. Call inside a transaction,
   * after `settle` re-checked every link. Rule 4.6-8: only `projectId` stays in the draft, and the summary
   * never names a project.
   */
  function fileItems(draft: StoredDraft, now: Date): { filed: ItemRef[]; summary: string; draft: StoredDraft } {
    const d: StoredDraft = {
      ...draft, candidates: [], suggested: false, personPending: false,
      projectCandidates: [], projectSuggested: false, projectPending: false,
    };
    const filed: ItemRef[] = [];
    let createdPerson = false;
    if (d.personCreate !== null) {
      const p = createPerson(db, { name: d.personCreate }, now);
      d.personId = p.id;
      d.personName = p.name;
      createdPerson = true;
    }
    let createdProject: Id | null = null;
    if (d.kind === 'agenda') {
      d.projectId = null; // agenda items have no project
    } else if (d.projectCreate !== null) {
      createdProject = createProject(db, { title: d.projectCreate }, now).id;
      d.projectId = createdProject;
    }
    let item: ItemRef;
    switch (d.kind) {
      case 'note':
        item = { kind: 'note', id: createNote(db, { bodyMd: d.text, personId: d.personId, projectId: d.projectId }, now).id };
        break;
      case 'action':
        item = { kind: 'action', id: createAction(db, { text: d.text, owner: d.owner, personId: d.personId, projectId: d.projectId }, now).id };
        break;
      case 'agenda':
        if (d.personId === null) throw new Error('agenda item needs a person');
        item = { kind: 'agenda', id: createAgendaItem(db, { personId: d.personId, text: d.text }, now).id };
        break;
      default:
        throw new Error('draft has no kind');
    }
    filed.push(item);
    if (createdPerson) filed.push({ kind: 'person', id: d.personId! });
    if (createdProject !== null) filed.push({ kind: 'project', id: createdProject });
    const summary = summarize(d, d.personId === null ? null : d.personName, createdPerson);
    d.personCreate = null; d.projectCreate = null; d.projectName = null;
    return { filed, summary, draft: d };
  }

  function softDeleteRefs(refs: ItemRef[], now: Date): void {
    for (const ref of refs) {
      if (!isItemRef(ref)) continue; // a person or project created by the capture is kept
      // A missing or already deleted item counts as gone.
      if (ref.kind === 'note') softDeleteNote(db, ref.id, now);
      else if (ref.kind === 'action') softDeleteAction(db, ref.id, now);
      else if (ref.kind === 'agenda') softDeleteAgendaItem(db, ref.id, now);
    }
  }

  type Fields = Pick<CaptureRecord, 'status' | 'draft' | 'question' | 'filed' | 'summary' | 'classifiedBy'>;

  const exactMatches = <T extends { name?: string; title?: string; aliases: string[] }>(rows: T[], name: string): T[] => {
    const want = foldName(name);
    return rows.filter((r) => [r.name ?? r.title ?? '', ...r.aliases].some((n) => foldName(n) === want));
  };

  /**
   * Files the draft in one transaction (no await inside). Before writing it re-checks every link against
   * the current data, because the world may have changed since the question was asked:
   *  - a person to create that now exists exactly once is linked instead, several times: ask again;
   *  - a linked person who was archived: drop the link and ask again;
   *  - a project to create that now exists exactly once is linked instead, several times: ask again;
   *  - a linked project that was deleted: the item files without a project (never a 500).
   * `persist` writes the capture row.
   */
  function settle(
    draft: StoredDraft, classifiedBy: Capture['classifiedBy'], now: Date,
    persist: (f: Fields) => CaptureRecord,
  ): CaptureRecord {
    return inTx(db, () => {
      const d: StoredDraft = { ...draft };
      const ask = (question: CaptureQuestion): CaptureRecord =>
        persist({ status: 'pending', draft: d, question, filed: [], summary: '', classifiedBy });

      if (d.personCreate !== null) {
        const name = d.personCreate;
        const found = exactMatches(listPeopleForMatching(db), name);
        if (found.length === 1) {
          d.personId = found[0]!.id; d.personName = found[0]!.name; d.personCreate = null;
        } else if (found.length > 1) {
          // Only one exact match may replace the explicit choice; several: the user decides.
          d.personCreate = null; d.personName = name; d.personPending = true; d.suggested = false;
          d.candidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
          return ask(ambiguousPersonQuestion(name, found, d.kind !== 'agenda'));
        }
      } else if (d.personId !== null) {
        const p = getPerson(db, d.personId);
        if (!p || p.archivedAt !== null) {
          // Never re-link by name here: the archived person's name may match someone else. Ask instead.
          d.personId = null; d.candidates = []; d.suggested = false; d.personPending = false;
          if (d.kind === 'agenda') {
            d.personName = null;
            return ask(needsPersonQuestion());
          }
          const name = p?.name ?? d.personName ?? 'Unknown';
          const others = resolveMention(name, listPeopleForMatching(db)).slice(0, MAX_CANDIDATES);
          d.personName = name;
          d.personPending = true;
          if (others.length === 0) return ask(unknownPersonQuestion(name, true));
          d.suggested = true;
          d.candidates = others.map((o) => o.id);
          return ask(ambiguousPersonQuestion(name, others, true));
        }
      }

      if (d.kind !== 'agenda') {
        if (d.projectCreate !== null) {
          const name = d.projectCreate;
          const found = exactMatches(listProjects(db), name);
          if (found.length === 1) {
            linkProject(d, found[0]!);
          } else if (found.length > 1) {
            d.projectCreate = null; d.projectName = name; d.projectPending = true; d.projectSuggested = false;
            d.projectCandidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
            return ask(ambiguousProjectQuestion(name, found));
          }
        } else if (d.projectId !== null && getProject(db, d.projectId) === null) {
          d.projectId = null; // deleted since the question was asked
        }
      }

      const f = fileItems(d, now);
      return persist({ status: 'filed', draft: f.draft, question: null, filed: f.filed, summary: f.summary, classifiedBy });
    });
  }

  return {
    async submit(text, source) {
      const parsed = parseCapture(text);
      if (parsed.text === '') throw new HttpError(400, 'validation_error', 'Nothing to capture');
      const people = listPeopleForMatching(db);
      const projects = listProjectsForMatching(db);
      const draft: StoredDraft = {
        ...emptyDraft(),
        kind: parsed.forcedKind, text: parsed.text, owner: parsed.forcedOwner ?? 'me',
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

      // Project: an explicit #mention first (only the first one is used), then known titles in the text.
      // Only a single multi-word match links silently; every other match is a suggestion that is asked.
      if (parsed.projectMentions.length > 0) {
        setProjectMention(draft, parsed.projectMentions[0]!, projects);
      } else {
        const { strong, weak } = findProjectsInText(parsed.text, projects);
        if (strong.length === 1) {
          linkProject(draft, strong[0]!);
        } else if (strong.length > 1 || weak.length > 0) {
          const cands = strong.length > 1 ? strong : weak;
          draft.projectPending = true;
          draft.projectSuggested = strong.length === 0;
          draft.projectCandidates = cands.slice(0, MAX_CANDIDATES).map((p) => p.id);
        }
      }

      // Kind: a prefix forces it; otherwise the LLM decides, but only when confident.
      if (draft.kind === null) {
        const out = await classify(parsed.text, people, projects);
        if (out !== null && out.confidence >= deps.config.classifyThreshold) {
          draft.kind = out.kind;
          draft.owner = out.owner;
          classifiedBy = 'llm';
          // The text scan above found nobody, so an LLM-named person is only a suggestion: always ask.
          // (A question asks nothing more: its people and projects are not suggested.)
          if (out.kind !== 'question' && draft.personId === null && !draft.personPending && out.personName !== null) {
            setMention(draft, out.personName, people, true);
          }
          // Likewise a project the LLM names is only a suggestion: always asked, never linked silently.
          if (out.kind !== 'question' && draft.projectId === null && !draft.projectPending && out.projectName !== null) {
            suggestProject(draft, out.projectName, projects);
          }
        }
      }

      // The classifier wait may have outlived a project: drop dead links and candidates (same rules as the scrub).
      if (draft.projectId !== null && getProject(db, draft.projectId) === null) {
        draft.projectId = null; draft.projectName = null;
      }
      if (draft.projectCandidates.length > 0) {
        const live = draft.projectCandidates.filter((id) => getProject(db, id) !== null);
        if (live.length !== draft.projectCandidates.length) {
          draft.projectCandidates = live;
          if (draft.projectSuggested) draft.projectName = null;
          if (live.length === 0) { draft.projectName = null; draft.projectPending = false; draft.projectSuggested = false; }
        }
      }

      const now = deps.now();
      // A question (`/ask`, `/q`, or a confident classification) is stored as `asked`; the client then calls /ask.
      if (draft.kind === 'question') {
        return toCapture(insertCapture(db, {
          text, source, status: 'asked', draft: questionDraft(draft), question: null, filed: [], summary: '', classifiedBy,
        }, now));
      }
      const question = nextQuestion(draft, people);
      if (question) {
        return toCapture(insertCapture(db, { text, source, status: 'pending', draft, question, filed: [], summary: '', classifiedBy }, now));
      }
      return toCapture(settle(draft, classifiedBy, now, (f) => insertCapture(db, { text, source, ...f }, now)));
    },

    async answer(id, answer) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      if (rec.status !== 'pending') return 'not_pending';
      const people = listPeopleForMatching(db);
      const q = rec.question ?? nextQuestion({ ...rec.draft }, people);
      // No question left (e.g. the only suggested project was deleted): only Skip (file as is) or Discard make sense.
      if (q === null && key0(answer) !== 's' && key0(answer) !== 'd') return 'bad_answer';
      const now = deps.now();
      const draft: StoredDraft = { ...rec.draft };
      let classifiedBy = rec.classifiedBy;
      let discard = false;
      let asQuestion = false;
      const clearProject = (): void => {
        draft.projectId = null; draft.projectName = null; draft.projectPending = false;
        draft.projectCandidates = []; draft.projectSuggested = false; draft.projectCreate = null;
      };
      const clearPerson = (): void => {
        draft.personPending = false; draft.candidates = []; draft.personName = null; draft.suggested = false;
      };
      const link = (p: { id: Id; name: string }): void => {
        draft.personId = p.id; draft.personName = p.name; draft.personPending = false; draft.candidates = []; draft.suggested = false;
      };

      const key = key0(answer);
      if (key === 'd') {
        discard = true;
      } else if (!('key' in answer)) {
        // Picking an existing person answers any person question, never the kind question.
        if (q === null || q.type === 'kind') return 'bad_answer';
        if ('projectId' in answer) {
          // Picking an existing project answers a project question (and only that).
          if (q.type !== 'unknown_project' && q.type !== 'ambiguous_project') return 'bad_answer';
          const exists = db.prepare('SELECT 1 AS x FROM projects WHERE id = ?').get(answer.projectId) !== undefined;
          if (!exists) return 'bad_answer';
          // Deleted since the picker was opened: the item files without a project.
          const p = getProject(db, answer.projectId);
          if (p) linkProject(draft, p);
          else clearProject();
        } else {
          if (q.type === 'unknown_project' || q.type === 'ambiguous_project') return 'bad_answer';
          const p = getPerson(db, answer.personId);
          if (!p || p.archivedAt !== null) return 'bad_answer';
          link(p);
        }
      } else if (q === null) {
        // key 's' (checked above): the capture is ready to file as it is.
      } else if (q.type === 'kind') {
        classifiedBy = 'user';
        if (key === 'q') {
          asQuestion = true;
        } else {
          const kind = KIND_KEYS.get(key!);
          if (kind === undefined) return 'bad_answer';
          draft.kind = kind;
        }
      } else if (q.type === 'unknown_person') {
        if (key === 'c') {
          const name = validName(q.name);
          if (name === null) return 'bad_answer';
          // Someone with exactly this name (or alias) may exist by now, e.g. created by an earlier pending
          // capture: never duplicate. A merely similar name ("Lisa Berg" for "Lisa") is not the same person.
          const want = foldName(name);
          const found = people.filter((p) => [p.name, ...p.aliases].some((n) => foldName(n) === want));
          if (found.length === 0) {
            // Created when the capture is filed (another question may still follow), after a duplicate re-check.
            draft.personCreate = name; draft.personName = name; draft.personPending = false;
            draft.candidates = []; draft.suggested = false;
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
      } else if (q.type === 'unknown_project') {
        if (key === 'c') {
          const name = validName(q.name);
          if (name === null) return 'bad_answer';
          // The duplicate check looks at every non-deleted project (done ones too): never create a twin.
          const found = exactMatches(listProjects(db), name);
          if (found.length === 0) {
            draft.projectCreate = name; draft.projectName = name; draft.projectPending = false;
            draft.projectCandidates = []; draft.projectSuggested = false;
          } else if (found.length === 1) {
            linkProject(draft, found[0]!);
          } else {
            draft.projectName = name; draft.projectPending = true; draft.projectSuggested = false;
            draft.projectCandidates = found.slice(0, MAX_CANDIDATES).map((p) => p.id);
          }
        } else if (key === 's') {
          clearProject();
        } else {
          return 'bad_answer'; // includes 'p': the client opens its project picker and sends { projectId }
        }
      } else if (q.type === 'ambiguous_project') {
        const cand = q.candidates.find((c) => c.key === key);
        if (cand) {
          const p = getProject(db, cand.projectId);
          if (p) linkProject(draft, p);
          else clearProject(); // deleted since the question was asked
        } else if (key === 's') {
          clearProject();
        } else {
          return 'bad_answer';
        }
      } else {
        return 'bad_answer'; // needs_person: only 'd' or a personId
      }

      if (discard) {
        return toCapture(updateCapture(db, id, { status: 'discarded', question: null, summary: 'Discarded' }, now)!);
      }
      if (asQuestion) {
        return toCapture(updateCapture(db, id, {
          status: 'asked', draft: questionDraft(draft), question: null, summary: '', classifiedBy,
        }, now)!);
      }
      const question = nextQuestion(draft, people);
      if (question) {
        return toCapture(updateCapture(db, id, { draft, question, classifiedBy }, now)!);
      }
      return toCapture(settle(draft, classifiedBy, now, (f) => updateCapture(db, id, f, now)!));
    },

    undo(id) {
      const rec = getCaptureRecord(db, id);
      if (!rec) return 'not_found';
      const now = deps.now();
      if (rec.status === 'asked' || rec.status === 'answered') {
        // The answer is a derived copy of the user's data: it is erased at once, with its sources.
        const out = toCapture(updateCapture(db, id, {
          status: 'discarded', question: null, summary: 'Discarded', answer: null, sources: null,
        }, now)!);
        if (rec.answer !== null) scrubWal();
        return out;
      }
      if (rec.status !== 'filed') return 'not_filed';
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
      const now = deps.now();
      if (rec.status === 'asked' || rec.status === 'answered') {
        // Back to the kind question; the answer and its sources are erased at once.
        const draft: StoredDraft = { ...rec.draft, kind: null, owner: 'me' };
        const out = toCapture(updateCapture(db, id, {
          status: 'pending', draft, question: kindQuestion(), summary: '', classifiedBy: null, answer: null, sources: null,
        }, now)!);
        if (rec.answer !== null) scrubWal();
        return out;
      }
      if (rec.status !== 'filed') return 'not_filed';
      return inTx(db, () => {
        const items = rec.filed.filter(isItemRef);
        if (items.length === 0 || liveItemKeys(db, items).size === 0) return 'gone' as const;
        softDeleteRefs(rec.filed, now);
        // The person link stays (also a person this capture created); `filed` is replaced, never appended to.
        const draft: StoredDraft = {
          ...rec.draft, kind: null, owner: 'me', personPending: false, candidates: [], suggested: false,
          projectPending: false, projectCandidates: [], projectSuggested: false, personCreate: null, projectCreate: null,
        };
        return toCapture(updateCapture(db, id, {
          status: 'pending', draft, question: kindQuestion(), filed: [], summary: '', classifiedBy: null,
        }, now)!);
      });
    },

    list(opts) {
      const recs = listCaptureRecords(db, opts);
      let people: PersonLike[] | null = null;
      return presentRecords(db, recs.map((r) => {
        // A pending capture with a damaged stored question gets it re-derived, as `answer` does.
        if (r.status === 'pending' && r.question === null) {
          people ??= listPeopleForMatching(db);
          return { ...r, question: nextQuestion({ ...r.draft }, people) };
        }
        return r;
      }));
    },
  };
}
