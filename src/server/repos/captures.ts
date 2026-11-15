import type { DatabaseSync } from 'node:sqlite';
import type {
  Capture, CaptureDraft, CaptureQuestion, Id, ItemKind, ItemRef, Owner,
} from '../../shared/types.ts';

/** What is stored in `captures.draft`: the public draft plus pipeline state the client never sees. */
export interface StoredDraft extends CaptureDraft {
  /** A person question is still open (unknown or ambiguous name). */
  personPending: boolean;
  /** Candidate person ids for an ambiguous person question (empty = unknown person). */
  candidates: Id[];
  /** The pending person came from the LLM: only a suggestion, never linked without asking. */
  suggested: boolean;
}

export interface CaptureRecord {
  id: Id; text: string; source: Capture['source']; status: Capture['status'];
  draft: StoredDraft; question: CaptureQuestion | null;
  filed: ItemRef[]; summary: string; classifiedBy: Capture['classifiedBy']; createdAt: string;
}

export type NewCapture = Omit<CaptureRecord, 'id' | 'createdAt'>;
export type CapturePatch = Partial<Omit<CaptureRecord, 'id' | 'createdAt' | 'text' | 'source'>>;

interface Row {
  id: number; text: string; source: Capture['source']; status: Capture['status'];
  draft: string; question: string | null; filed: string; summary: string;
  classified_by: Capture['classifiedBy']; created_at: string; updated_at: string;
}

const ITEM_KINDS = new Set<string>(['note', 'action', 'agenda']);
const REF_KINDS = new Set<string>(['note', 'action', 'agenda', 'person']);
const QUESTION_TYPES = new Set<string>(['kind', 'unknown_person', 'ambiguous_person', 'needs_person']);
const TABLES: Record<ItemKind, string> = { note: 'notes', action: 'actions', agenda: 'agenda_items' };

function parseJson(s: string | null): unknown {
  if (s === null) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function emptyDraft(): StoredDraft {
  return { kind: null, text: '', personId: null, personName: null, owner: 'me', personPending: false, candidates: [], suggested: false };
}

/** Never throws: a damaged row degrades to an empty draft instead of breaking the chat list. */
function parseDraft(s: string): StoredDraft {
  const v = parseJson(s);
  const d = emptyDraft();
  if (!isObj(v)) return d;
  if (typeof v.kind === 'string' && ITEM_KINDS.has(v.kind)) d.kind = v.kind as ItemKind;
  if (typeof v.text === 'string') d.text = v.text;
  if (typeof v.personId === 'number' && Number.isInteger(v.personId)) d.personId = v.personId;
  if (typeof v.personName === 'string') d.personName = v.personName;
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
  if (v.type === 'unknown_person') return { type: 'unknown_person', name: v.name, options: v.options } as CaptureQuestion;
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

function mapRow(r: Row): CaptureRecord {
  return {
    id: r.id, text: r.text, source: r.source, status: r.status, draft: parseDraft(r.draft),
    question: parseQuestion(r.question), filed: parseFiled(r.filed), summary: r.summary,
    classifiedBy: r.classified_by, createdAt: r.created_at,
  };
}

export function insertCapture(db: DatabaseSync, input: NewCapture & { text: string }, now: Date): CaptureRecord {
  const ts = now.toISOString();
  const res = db
    .prepare(
      `INSERT INTO captures (text, source, status, draft, question, filed, summary, classified_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.text, input.source, input.status, JSON.stringify(input.draft),
      input.question === null ? null : JSON.stringify(input.question),
      JSON.stringify(input.filed), input.summary, input.classifiedBy, ts, ts,
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
    `UPDATE captures SET status = ?, draft = ?, question = ?, filed = ?, summary = ?, classified_by = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.status, JSON.stringify(next.draft), next.question === null ? null : JSON.stringify(next.question),
    JSON.stringify(next.filed), next.summary, next.classifiedBy, now.toISOString(), id,
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
