import type { DatabaseSync } from 'node:sqlite';
import { scrubProjectFromCaptures } from './captures.ts';

const ANSWER_KINDS = new Set(['note', 'action', 'agenda', 'person', 'project', 'meeting']);
const ANSWER_TABLES: Record<string, string> = { note: 'notes', action: 'actions', agenda: 'agenda_items', project: 'projects' };

const DAY_MS = 86_400_000;

export interface PurgeResult { notes: number; actions: number; agendaItems: number; captures: number; projects: number }

const KIND_TABLE = { note: 'notes', action: 'actions', agenda: 'agenda_items' } as const;
type Kind = keyof typeof KIND_TABLE;

/**
 * Hard-deletes, in one transaction:
 *  - notes, actions and agenda items soft-deleted more than `days` days ago;
 *  - chat captures whose `filed` refs point at any of those rows (the capture holds the same text in
 *    `text`, `draft` and `summary`, so it must go with them);
 *  - answered captures (question answering) whose `sources.sent` names any of the rows being purged, or any
 *    note, action, agenda item or project that no longer exists: the answer is a derived copy of every excerpt;
 *  - projects soft-deleted more than `days` days ago (their capture scrub is re-run as a safety net, their
 *    leftover links are cleared first so no foreign key blocks the delete);
 *  - pins and recents rows whose person, project, meeting or note no longer exists;
 *  - captures with status `undone` or `discarded` not updated for more than `days` days.
 * Then, if anything was deleted, truncates the WAL so the erased bytes do not survive in it
 * (`secure_delete` is ON in openDb, which zeroes freed pages). Returns counts only; never log contents.
 *
 * FK check (001-init.sql): nothing references notes, actions or agenda_items by foreign key. Capture
 * `filed` JSON refs are the only pointers, and ids are never reused (migration 003, AUTOINCREMENT).
 */
export function purgeDeleted(db: DatabaseSync, now: Date, days = 30): PurgeResult {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const result: PurgeResult = { notes: 0, actions: 0, agendaItems: 0, captures: 0, projects: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    const purged: Record<Kind, Set<number>> = { note: new Set(), action: new Set(), agenda: new Set() };
    for (const kind of Object.keys(KIND_TABLE) as Kind[]) {
      const rows = db
        .prepare(`SELECT id FROM ${KIND_TABLE[kind]} WHERE deleted_at IS NOT NULL AND deleted_at < ?`)
        .all(cutoff) as unknown as { id: number }[];
      for (const r of rows) purged[kind].add(r.id);
    }

    const doomed = new Set<number>();
    const anyItems = purged.note.size + purged.action.size + purged.agenda.size > 0;
    const filedRows = anyItems
      ? (db.prepare("SELECT id, filed FROM captures WHERE filed != '[]'").all() as unknown as { id: number; filed: string }[])
      : [];
    for (const row of filedRows) {
      // A malformed row must never stop the purge: skip it.
      let refs: unknown;
      try { refs = JSON.parse(row.filed); } catch { continue; }
      if (!Array.isArray(refs)) continue;
      for (const ref of refs as unknown[]) {
        if (typeof ref !== 'object' || ref === null) continue;
        const { kind, id } = ref as { kind?: unknown; id?: unknown };
        if (typeof kind === 'string' && typeof id === 'number' && Object.hasOwn(KIND_TABLE, kind) && purged[kind as Kind].has(id)) {
          doomed.add(row.id);
          break;
        }
      }
    }
    // Answers: erased when ANY item that was sent to the LLM for them is purged or already gone.
    const projectsDue = (
      db.prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as unknown as { id: number }[]
    ).map((r) => r.id);
    const purgedProjects = new Set(projectsDue);
    const answered = db.prepare("SELECT id, sources FROM captures WHERE status = 'answered' OR sources IS NOT NULL").all() as unknown as
      { id: number; sources: string | null }[];
    const exists: Record<string, ReturnType<typeof db.prepare>> = {};
    for (const [k, t] of Object.entries(ANSWER_TABLES)) exists[k] = db.prepare(`SELECT 1 AS x FROM ${t} WHERE id = ?`);
    for (const row of answered) {
      let sent: unknown;
      let cited: unknown;
      try {
        const parsed = JSON.parse(row.sources ?? 'null') as { sent?: unknown; cited?: unknown } | null;
        sent = parsed?.sent;
        cited = parsed?.cited;
      } catch { sent = undefined; }
      // A damaged or missing source list on an answer cannot be judged: erase it (fail closed). One bad entry
      // damages the whole list, since a shortened list could hide a purged item.
      if (!Array.isArray(sent) || !Array.isArray(cited)) { doomed.add(row.id); continue; }
      let damaged = false;
      for (const ref of cited as unknown[]) {
        const { kind, id } = (typeof ref === 'object' && ref !== null ? ref : {}) as { kind?: unknown; id?: unknown };
        if (typeof kind !== 'string' || !ANSWER_KINDS.has(kind) || !Number.isInteger(id)) damaged = true;
      }
      let due = false;
      for (const ref of sent as unknown[]) {
        const { kind, id } = (typeof ref === 'object' && ref !== null ? ref : {}) as { kind?: unknown; id?: unknown };
        if (typeof kind !== 'string' || !Number.isInteger(id) || typeof id !== 'number' || !ANSWER_KINDS.has(kind)) { damaged = true; break; }
        if (!Object.hasOwn(ANSWER_TABLES, kind)) continue; // person, meeting: never erase an answer
        const gone = kind === 'project' ? purgedProjects.has(id) : purged[kind as Kind].has(id);
        if (gone || exists[kind]!.get(id) === undefined) due = true;
      }
      if (damaged || due) doomed.add(row.id);
    }
    const old = db
      .prepare("SELECT id FROM captures WHERE status IN ('undone','discarded') AND updated_at < ?")
      .all(cutoff) as unknown as { id: number }[];
    for (const r of old) doomed.add(r.id);

    const delCapture = db.prepare('DELETE FROM captures WHERE id = ?');
    for (const id of doomed) result.captures += Number(delCapture.run(id).changes);
    for (const [kind, key] of [['note', 'notes'], ['action', 'actions'], ['agenda', 'agendaItems']] as const) {
      const del = db.prepare(`DELETE FROM ${KIND_TABLE[kind]} WHERE id = ?`);
      for (const id of purged[kind]) result[key] += Number(del.run(id).changes);
    }

    const projectIds = (
      db.prepare('SELECT id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at < ?').all(cutoff) as unknown as { id: number }[]
    ).map((r) => r.id);
    for (const id of projectIds) {
      try { scrubProjectFromCaptures(db, id, now); } catch { /* a bad capture row never stops the purge */ }
      db.prepare('UPDATE actions SET project_id = NULL WHERE project_id = ?').run(id);
      db.prepare('UPDATE notes SET project_id = NULL WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM project_people WHERE project_id = ?').run(id);
      result.projects += Number(db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes);
    }
    for (const t of ['pins', 'recents']) {
      db.exec(
        `DELETE FROM ${t} WHERE
           (kind = 'note' AND item_id NOT IN (SELECT id FROM notes))
           OR (kind = 'project' AND item_id NOT IN (SELECT id FROM projects))
           OR (kind = 'person' AND item_id NOT IN (SELECT id FROM people))
           OR (kind = 'meeting' AND item_id NOT IN (SELECT id FROM meetings))`,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (result.notes + result.actions + result.agendaItems + result.captures + result.projects > 0) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort; the purge itself is committed */ }
  }
  return result;
}
