import type { DatabaseSync } from 'node:sqlite';

const DAY_MS = 86_400_000;

export interface PurgeResult { notes: number; actions: number; agendaItems: number; captures: number }

const KIND_TABLE = { note: 'notes', action: 'actions', agenda: 'agenda_items' } as const;
type Kind = keyof typeof KIND_TABLE;

/**
 * Hard-deletes, in one transaction:
 *  - notes, actions and agenda items soft-deleted more than `days` days ago;
 *  - chat captures whose `filed` refs point at any of those rows (the capture holds the same text in
 *    `text`, `draft` and `summary`, so it must go with them);
 *  - captures with status `undone` or `discarded` not updated for more than `days` days.
 * Then, if anything was deleted, truncates the WAL so the erased bytes do not survive in it
 * (`secure_delete` is ON in openDb, which zeroes freed pages). Returns counts only; never log contents.
 *
 * FK check (001-init.sql): nothing references notes, actions or agenda_items by foreign key. Capture
 * `filed` JSON refs are the only pointers, and ids are never reused (migration 003, AUTOINCREMENT).
 */
export function purgeDeleted(db: DatabaseSync, now: Date, days = 30): PurgeResult {
  const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
  const result: PurgeResult = { notes: 0, actions: 0, agendaItems: 0, captures: 0 };
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  if (result.notes + result.actions + result.agendaItems + result.captures > 0) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort; the purge itself is committed */ }
  }
  return result;
}
