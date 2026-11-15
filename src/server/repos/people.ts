import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import type { MeetingHeader, PersonDetailResponse } from '../../shared/api.ts';
import type { Action, AgendaItem, Id, Meeting, Note, Person, PersonDetail } from '../../shared/types.ts';
import { mapAction } from './actions.ts';
import { mapAgendaItem } from './agenda.ts';
import { mapNote } from './notes.ts';

interface PersonRow {
  id: number; name: string; aliases: string; notes_md: string;
  created_at: string; updated_at: string; archived_at: string | null;
}

function parseAliases(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function mapPerson(r: PersonRow): Person {
  return {
    id: r.id, name: r.name, aliases: parseAliases(r.aliases), notesMd: r.notes_md,
    createdAt: r.created_at, updatedAt: r.updated_at, archivedAt: r.archived_at,
  };
}

/** Trim, drop empty entries and case-insensitive duplicates. */
export function normalizeAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim();
    const k = t.toLowerCase();
    if (t === '' || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Unicode-aware, accent-insensitive-at-base ordering (Swedish collation), ties by id. */
function byName(a: Person, b: Person): number {
  return a.name.localeCompare(b.name, 'sv', { sensitivity: 'base' }) || a.id - b.id;
}

export function listPeople(db: DatabaseSync, opts: { includeArchived?: boolean } = {}): Person[] {
  const sql = opts.includeArchived ? 'SELECT * FROM people' : 'SELECT * FROM people WHERE archived_at IS NULL';
  return (db.prepare(sql).all() as unknown as PersonRow[]).map(mapPerson).sort(byName);
}

/** Slim list for name matching: non-archived people without their notes, sorted like listPeople. */
export function listPeopleForMatching(db: DatabaseSync): Pick<Person, 'id' | 'name' | 'aliases'>[] {
  const rows = db
    .prepare('SELECT id, name, aliases FROM people WHERE archived_at IS NULL')
    .all() as unknown as { id: number; name: string; aliases: string }[];
  return rows
    .map((r) => ({ id: r.id, name: r.name, aliases: parseAliases(r.aliases) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'sv', { sensitivity: 'base' }) || a.id - b.id);
}

export function getPerson(db: DatabaseSync, id: Id): Person | null {
  const r = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as unknown as PersonRow | undefined;
  return r ? mapPerson(r) : null;
}

export function createPerson(db: DatabaseSync, input: { name: string; aliases?: string[] }, now: Date): Person {
  const ts = now.toISOString();
  const res = db
    .prepare('INSERT INTO people (name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(input.name.trim(), JSON.stringify(normalizeAliases(input.aliases ?? [])), ts, ts);
  return getPerson(db, Number(res.lastInsertRowid))!;
}

export function updatePerson(
  db: DatabaseSync,
  id: Id,
  patch: { name?: string; aliases?: string[]; notesMd?: string; archived?: boolean },
  now: Date,
): Person | null {
  const cur = getPerson(db, id);
  if (!cur) return null;
  const ts = now.toISOString();
  let archivedAt = cur.archivedAt;
  if (patch.archived === true && archivedAt === null) archivedAt = ts;
  if (patch.archived === false) archivedAt = null;
  db.prepare('UPDATE people SET name = ?, aliases = ?, notes_md = ?, archived_at = ?, updated_at = ? WHERE id = ?').run(
    patch.name !== undefined ? patch.name.trim() : cur.name,
    JSON.stringify(patch.aliases !== undefined ? normalizeAliases(patch.aliases) : cur.aliases),
    patch.notesMd ?? cur.notesMd,
    archivedAt,
    ts,
    id,
  );
  return getPerson(db, id);
}

interface MeetingRow { id: number; person_id: number; started_at: string; ended_at: string | null; notes_md: string }

interface NoteSummaryRow {
  id: number; title: string; preview: string; person_id: number | null; created_at: string; updated_at: string;
}

function activeMeetingId(db: DatabaseSync, id: Id): Id | null {
  const r = db
    .prepare('SELECT id FROM meetings WHERE person_id = ? AND ended_at IS NULL')
    .get(id) as unknown as { id: number } | undefined;
  return r ? r.id : null;
}

function openItems(db: DatabaseSync, id: Id): { openAgenda: AgendaItem[]; openActions: Action[] } {
  const openAgenda = (
    db
      .prepare("SELECT * FROM agenda_items WHERE person_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY id")
      .all(id) as unknown as Parameters<typeof mapAgendaItem>[0][]
  ).map(mapAgendaItem);
  const openActions = (
    db
      .prepare("SELECT * FROM actions WHERE person_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY id")
      .all(id) as unknown as Parameters<typeof mapAction>[0][]
  ).map(mapAction);
  return { openAgenda, openActions };
}

/** Full detail (all meetings and notes, full bodies): for export and internal use. */
export function getPersonDetail(db: DatabaseSync, id: Id): PersonDetail | null {
  const person = getPerson(db, id);
  if (!person) return null;
  const notes: Note[] = (
    db
      .prepare('SELECT * FROM notes WHERE person_id = ? AND deleted_at IS NULL ORDER BY id DESC')
      .all(id) as unknown as Parameters<typeof mapNote>[0][]
  ).map(mapNote);
  const meetings: Meeting[] = (db.prepare('SELECT * FROM meetings WHERE person_id = ? ORDER BY id DESC').all(id) as unknown as MeetingRow[]).map(
    (m) => ({ id: m.id, personId: m.person_id, startedAt: m.started_at, endedAt: m.ended_at, notesMd: m.notes_md }),
  );
  return { person, ...openItems(db, id), notes, meetings, activeMeetingId: activeMeetingId(db, id) };
}

interface HeaderRow { id: number; person_id: number; started_at: string; ended_at: string | null; preview: string }

/** Meeting headers, newest first; `before` is an id cursor. Previews are cut in SQL, not in JS. */
export function listMeetingHeaders(
  db: DatabaseSync,
  personId: Id,
  opts: { limit?: number; before?: Id } = {},
): MeetingHeader[] {
  const params: number[] = [LIMITS.notePreview, personId];
  let where = 'person_id = ?';
  if (opts.before !== undefined) { where += ' AND id < ?'; params.push(opts.before); }
  params.push(opts.limit ?? LIMITS.personMeetings);
  const rows = db
    .prepare(`SELECT id, person_id, started_at, ended_at, substr(notes_md, 1, ?) AS preview FROM meetings WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params) as unknown as HeaderRow[];
  return rows.map((r) => ({ id: r.id, personId: r.person_id, startedAt: r.started_at, endedAt: r.ended_at, preview: r.preview }));
}

/** What the API returns: note previews (latest 50) and meeting headers (latest 50). */
export function getPersonDetailSummary(db: DatabaseSync, id: Id): PersonDetailResponse | null {
  const person = getPerson(db, id);
  if (!person) return null;
  const notes = (
    db
      .prepare(
        `SELECT id, title, substr(body_md, 1, ?) AS preview, person_id, created_at, updated_at
         FROM notes WHERE person_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT ?`,
      )
      .all(LIMITS.notePreview, id, LIMITS.personNotes) as unknown as NoteSummaryRow[]
  ).map((r) => ({
    id: r.id, title: r.title, preview: r.preview, personId: r.person_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
  return {
    person, ...openItems(db, id), notes,
    meetings: listMeetingHeaders(db, id), activeMeetingId: activeMeetingId(db, id),
  };
}
