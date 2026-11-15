import type { DatabaseSync } from 'node:sqlite';
import type {
  Capture, CaptureDraft, CaptureQuestion, Id, ItemKind, ItemRef, Owner, SourceRef,
} from '../../shared/types.ts';

/** What is stored in `captures.draft`: the public draft plus pipeline state the client never sees. */
export interface StoredDraft extends CaptureDraft {
  /** A person question is still open (unknown or ambiguous name). */
  personPending: boolean;
  /** Candidate person ids for an ambiguous person question (empty = unknown person). */
  candidates: Id[];
  /** The pending person came from the LLM: only a suggestion, never linked without asking. */
  suggested: boolean;
  /** A project question is still open (unknown, ambiguous or suggested project). */
  projectPending: boolean;
  /** Candidate project ids for an ambiguous project question (empty = unknown project). */
  projectCandidates: Id[];
  /** The pending project came from free text or the LLM: only a suggestion, never linked without asking. */
  projectSuggested: boolean;
  /** Name of a person to create when the capture is filed (not created before). */
  personCreate: string | null;
  /** Title of a project to create when the capture is filed (not created before). */
  projectCreate: string | null;
}

/** A document an answer drew on: ids only, never titles (titles are looked up when the capture is read). */
export interface StoredRef { kind: SourceRef['kind']; id: Id }
/** `sent`: every excerpt that went to the LLM (what erasure is judged by); `cited`: the ones the answer used. */
export interface StoredSources { sent: StoredRef[]; cited: StoredRef[] }

export interface CaptureRecord {
  id: Id; text: string; source: Capture['source']; status: Capture['status'];
  draft: StoredDraft; question: CaptureQuestion | null;
  filed: ItemRef[]; summary: string; classifiedBy: Capture['classifiedBy']; createdAt: string;
  /** The stored answer text (status `answered`); a derived copy of every sent excerpt. */
  answer: string | null;
  sources: StoredSources | null;
}

export type NewCapture = Omit<CaptureRecord, 'id' | 'createdAt' | 'answer' | 'sources'> & { answer?: string | null; sources?: StoredSources | null };
export type CapturePatch = Partial<Omit<CaptureRecord, 'id' | 'createdAt' | 'text' | 'source'>>;

interface Row {
  id: number; text: string; source: Capture['source']; status: Capture['status'];
  draft: string; question: string | null; filed: string; summary: string;
  classified_by: Capture['classifiedBy']; created_at: string; updated_at: string;
  answer: string | null; sources: string | null;
}

const DRAFT_KINDS = new Set<string>(['note', 'action', 'agenda', 'question']);
const SOURCE_KINDS = new Set<string>(['note', 'action', 'agenda', 'person', 'project', 'meeting']);
const REF_KINDS = new Set<string>(['note', 'action', 'agenda', 'person', 'project']);
const QUESTION_TYPES = new Set<string>([
  'kind', 'unknown_person', 'ambiguous_person', 'needs_person', 'unknown_project', 'ambiguous_project',
]);
const TABLES: Record<ItemKind, string> = { note: 'notes', action: 'actions', agenda: 'agenda_items' };

function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function emptyDraft(): StoredDraft {
  return { kind: null, text: '', personId: null, personName: null, projectId: null, projectName: null, owner: 'me',
    personPending: false, candidates: [], suggested: false,
    projectPending: false, projectCandidates: [], projectSuggested: false, personCreate: null, projectCreate: null,
  };
}

/** Never throws: a damaged row degrades to an empty draft instead of breaking the chat list. */
function parseDraft(s: string): StoredDraft {
  const v = parseJson(s);
  const d = emptyDraft();
  if (!isObj(v)) return d;
  if (typeof v.kind === 'string' && DRAFT_KINDS.has(v.kind)) d.kind = v.kind as CaptureDraft['kind'];
  if (typeof v.text === 'string') d.text = v.text;
  if (typeof v.personId === 'number' && Number.isInteger(v.personId)) d.personId = v.personId;
  if (typeof v.personName === 'string') d.personName = v.personName;
  if (typeof v.projectId === 'number' && Number.isInteger(v.projectId)) d.projectId = v.projectId;
  if (typeof v.projectName === 'string') d.projectName = v.projectName;
  if (typeof v.personCreate === 'string') d.personCreate = v.personCreate;
  if (typeof v.projectCreate === 'string') d.projectCreate = v.projectCreate;
  d.projectPending = v.projectPending === true;
  d.projectSuggested = v.projectSuggested === true;
  if (Array.isArray(v.projectCandidates)) {
    d.projectCandidates = v.projectCandidates.filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
  }
  if (v.owner === 'me' || v.owner === 'them') d.owner = v.owner as Owner;
  d.personPending = v.personPending === true;
  d.suggested = v.suggested === true;
  if (Array.isArray(v.candidates)) {
    d.candidates = v.candidates.filter((x): x is number => typeof x === 'number' && Number.isInteger(x));
  }
  return d;
}

function isOptions(v: unknown): boolean {
  return Array.isArray(v) && v.every((o) => isObj(o) && typeof o.key === 'string' && typeof o.label === 'string');
}

/** Shape-checks a stored question per type; anything off returns null so the pipeline re-derives it. */
function parseQuestion(s: string | null): CaptureQuestion | null {
  const v = parseJson(s);
  if (!isObj(v) || typeof v.type !== 'string' || !QUESTION_TYPES.has(v.type) || !isOptions(v.options)) return null;
  if (v.type === 'kind' || v.type === 'needs_person') return { type: v.type, options: v.options } as CaptureQuestion;
  if (typeof v.name !== 'string') return null;
  if (v.type === 'unknown_person' || v.type === 'unknown_project') {
    return { type: v.type, name: v.name, options: v.options } as CaptureQuestion;
  }
  if (v.type === 'ambiguous_project') {
    if (
      !Array.isArray(v.candidates) ||
      !v.candidates.every((c) => isObj(c) && typeof c.key === 'string' && typeof c.title === 'string' && typeof c.projectId === 'number' && Number.isInteger(c.projectId))
    ) return null;
    return { type: 'ambiguous_project', name: v.name, candidates: v.candidates, options: v.options } as CaptureQuestion;
  }
  if (
    !Array.isArray(v.candidates) ||
    !v.candidates.every((c) => isObj(c) && typeof c.key === 'string' && typeof c.name === 'string' && typeof c.personId === 'number' && Number.isInteger(c.personId))
  ) return null;
  return { type: 'ambiguous_person', name: v.name, candidates: v.candidates, options: v.options } as CaptureQuestion;
}

function parseFiled(s: string): ItemRef[] {
  const v = parseJson(s);
  if (!Array.isArray(v)) return [];
  const out: ItemRef[] = [];
  for (const r of v as unknown[]) {
    if (isObj(r) && typeof r.kind === 'string' && REF_KINDS.has(r.kind) && typeof r.id === 'number' && Number.isInteger(r.id)) {
      out.push({ kind: r.kind as ItemRef['kind'], id: r.id });
    }
  }
  return out;
}

/** All-or-nothing: one malformed entry makes the whole list unreadable (null), never a shorter list. */
function parseRefList(v: unknown): StoredRef[] | null {
  if (!Array.isArray(v)) return null;
  const out: StoredRef[] = [];
  for (const r of v as unknown[]) {
    if (!(isObj(r) && typeof r.kind === 'string' && SOURCE_KINDS.has(r.kind) && typeof r.id === 'number' && Number.isInteger(r.id))) return null;
    out.push({ kind: r.kind as StoredRef['kind'], id: r.id });
  }
  return out;
}

/**
 * Never throws. Damaged JSON, or any damaged entry in `sent` or `cited`, is `null`; the reader then treats an
 * answered capture as redacted (fail closed): a shortened `sent` list could hide a deleted item.
 */
function parseSources(s: string | null): StoredSources | null {
  const v = parseJson(s);
  if (!isObj(v)) return null;
  const sent = parseRefList(v.sent);
  const cited = parseRefList(v.cited);
  return sent && cited ? { sent, cited } : null;
}

function mapRow(r: Row): CaptureRecord {
  return {
    id: r.id, text: r.text, source: r.source, status: r.status, draft: parseDraft(r.draft),
    question: parseQuestion(r.question), filed: parseFiled(r.filed), summary: r.summary,
    classifiedBy: r.classified_by, createdAt: r.created_at, answer: r.answer, sources: parseSources(r.sources),
  };
}

export function insertCapture(db: DatabaseSync, input: NewCapture & { text: string }, now: Date): CaptureRecord {
  const ts = now.toISOString();
  const res = db
    .prepare(
      `INSERT INTO captures (text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at, answer, sources)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.text, input.source, input.status, JSON.stringify(input.draft),
      input.question === null ? null : JSON.stringify(input.question),
      JSON.stringify(input.filed), input.summary, input.classifiedBy, ts, ts,
      input.answer ?? null, input.sources ? JSON.stringify(input.sources) : null,
    );
  return getCaptureRecord(db, Number(res.lastInsertRowid))!;
}

export function getCaptureRecord(db: DatabaseSync, id: Id): CaptureRecord | null {
  const r = db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as unknown as Row | undefined;
  return r ? mapRow(r) : null;
}

/** Replaces the given fields (never merges `filed`: a capture holds only its current filing). */
export function updateCapture(db: DatabaseSync, id: Id, patch: CapturePatch, now: Date): CaptureRecord | null {
  const cur = getCaptureRecord(db, id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE captures SET status = ?, draft = ?, question = ?, filed = ?, summary = ?, classified_by = ?, updated_at = ?,
       answer = ?, sources = ?
     WHERE id = ?`,
  ).run(
    next.status, JSON.stringify(next.draft), next.question === null ? null : JSON.stringify(next.question),
    JSON.stringify(next.filed), next.summary, next.classifiedBy, now.toISOString(),
    next.answer, next.sources ? JSON.stringify(next.sources) : null, id,
  );
  return getCaptureRecord(db, id);
}

/** Newest page, returned oldest first; `before` is an id cursor. */
export function listCaptureRecords(db: DatabaseSync, opts: { limit: number; before?: Id }): CaptureRecord[] {
  const rows =
    opts.before !== undefined
      ? (db.prepare('SELECT * FROM captures WHERE id < ? ORDER BY id DESC LIMIT ?').all(opts.before, opts.limit) as unknown as Row[])
      : (db.prepare('SELECT * FROM captures ORDER BY id DESC LIMIT ?').all(opts.limit) as unknown as Row[]);
  return rows.reverse().map(mapRow);
}

/** Which of the given note/action/agenda refs still exist and are not soft-deleted ("kind:id" keys). */
export function liveItemKeys(db: DatabaseSync, refs: ItemRef[]): Set<string> {
  const live = new Set<string>();
  for (const kind of ['note', 'action', 'agenda'] as const) {
    const ids = [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
    // Chunked so the number of bound parameters stays small; only "?" placeholders are built.
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const marks = chunk.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id FROM ${TABLES[kind]} WHERE deleted_at IS NULL AND id IN (${marks})`)
        .all(...chunk) as unknown as { id: number }[];
      for (const r of rows) live.add(`${kind}:${r.id}`);
    }
  }
  return live;
}

const ONE_LINE_MAX = 100;
const oneLine = (s: string): string => Array.from(s.replace(/\s+/g, ' ').trim()).slice(0, ONE_LINE_MAX).join('');

/**
 * Which of the given refs still exist, with their current title ("kind:id" -> title). Notes, actions,
 * agenda items and projects count only while not soft-deleted; people and meetings only while they exist.
 * Titles are read here, at read time, and never stored.
 */
export function liveSourceTitles(db: DatabaseSync, refs: StoredRef[]): Map<string, string> {
  const out = new Map<string, string>();
  const sql: Record<StoredRef['kind'], string> = {
    note: 'SELECT id, title AS t FROM notes WHERE deleted_at IS NULL AND id IN',
    action: 'SELECT id, text AS t FROM actions WHERE deleted_at IS NULL AND id IN',
    agenda: 'SELECT id, text AS t FROM agenda_items WHERE deleted_at IS NULL AND id IN',
    project: 'SELECT id, title AS t FROM projects WHERE deleted_at IS NULL AND id IN',
    person: 'SELECT id, name AS t FROM people WHERE id IN',
    meeting: "SELECT m.id AS id, '1-1 ' || p.name || ' ' || substr(m.started_at, 1, 10) AS t FROM meetings m JOIN people p ON p.id = m.person_id WHERE m.id IN",
  };
  for (const kind of Object.keys(sql) as StoredRef['kind'][]) {
    const ids = [...new Set(refs.filter((r) => r.kind === kind).map((r) => r.id))];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const rows = db.prepare(`${sql[kind]} (${chunk.map(() => '?').join(',')})`).all(...chunk) as unknown as { id: number; t: string }[];
      for (const r of rows) out.set(`${kind}:${r.id}`, oneLine(r.t));
    }
  }
  return out;
}

/**
 * Erasure for a deleted project (plan 4.7, amended). A draft references the project only through
 * `projectId` or `projectCandidates`, never through a name match alone:
 *  - `projectId` = the project: set to null and clear `projectName`;
 *  - in `projectCandidates`: remove it (and clear `projectName` when the pending project is only a suggestion,
 *    since the suggested name can be this project's title); if none remain, clear `projectName`,
 *    `projectPending`, `projectSuggested`;
 *  - the stored question is set to NULL (the pipeline re-derives it) only when it is a project question
 *    naming this project's id (also an unreadable one whose raw candidates name it), or when the draft
 *    referenced the project; `unknown_project` is never touched
 *    on its own, and a draft linked to another project is left alone;
 *  - `projectCreate` is left alone; the `{kind:'project'}` ref is dropped from `filed`.
 * Never throws on a bad row. `updated_at` is unchanged so the scrub does not extend retention.
 */
export function scrubProjectFromCaptures(db: DatabaseSync, projectId: Id, _now: Date): number {
  const rows = db.prepare('SELECT id, draft, question, filed FROM captures').all() as unknown as
    { id: number; draft: string; question: string | null; filed: string }[];
  const upd = db.prepare('UPDATE captures SET draft = ?, question = ?, filed = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const draft = parseDraft(row.draft);
    const refs = parseFiled(row.filed);
    const rawQ = parseJson(row.question);
    const q = parseQuestion(row.question);
    const hadLink = draft.projectId === projectId;
    const hadCand = draft.projectCandidates.includes(projectId);
    const hadRef = refs.some((r) => r.kind === 'project' && r.id === projectId);
    const qNamesIt = q?.type === 'ambiguous_project' && q.candidates.some((c) => c.projectId === projectId);
    // An unreadable stored ambiguous_project question may hold candidate titles: drop it whenever its raw
    // candidates name this project id, even when the draft itself does not reference the project.
    const qBad = q === null && row.question !== null && isObj(rawQ) && rawQ.type === 'ambiguous_project' &&
      Array.isArray(rawQ.candidates) && rawQ.candidates.some((c) => isObj(c) && c.projectId === projectId);
    if (!(hadLink || hadCand || hadRef || qNamesIt || qBad)) continue;
    if (hadLink) { draft.projectId = null; draft.projectName = null; }
    if (hadCand) {
      draft.projectCandidates = draft.projectCandidates.filter((id) => id !== projectId);
      // An LLM- or text-suggested name can be the deleted project's own title: it goes with the candidate.
      if (draft.projectSuggested) draft.projectName = null;
      if (draft.projectCandidates.length === 0) {
        draft.projectName = null; draft.projectPending = false; draft.projectSuggested = false;
      }
    }
    const question = hadLink || hadCand || qNamesIt || qBad ? null : row.question;
    upd.run(
      JSON.stringify(draft), question,
      JSON.stringify(refs.filter((r) => !(r.kind === 'project' && r.id === projectId))), row.id,
    );
    changed++;
  }
  return changed;
}
