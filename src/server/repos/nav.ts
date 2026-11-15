import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import type { NavResponse } from '../../shared/api.ts';
import type { Id, NavItem, NavKind } from '../../shared/types.ts';

export type PinKind = 'person' | 'project';

/** Existence per kind: missing or soft-deleted items do not exist; archived people do. */
const EXISTS: Record<NavKind, string> = {
  person: 'SELECT 1 FROM people WHERE id = ?',
  project: 'SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL',
  meeting: 'SELECT 1 FROM meetings WHERE id = ?',
  note: 'SELECT 1 FROM notes WHERE id = ? AND deleted_at IS NULL',
};

export function navItemExists(db: DatabaseSync, kind: NavKind, id: Id): boolean {
  return db.prepare(EXISTS[kind]).get(id) !== undefined;
}

interface Row { kind: NavKind; item_id: number; title: string | null; archived: number }

/**
 * Titles are read live (pins and recents hold ids only). Rows whose item is missing or soft-deleted get
 * a NULL title and are dropped. `table`, `col` and `dir` are constants, never user input.
 */
function listNav(db: DatabaseSync, table: 'pins' | 'recents', col: 'created_at' | 'opened_at', dir: 'ASC' | 'DESC', limit: number): NavItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT t.kind AS kind, t.item_id AS item_id, t.rowid AS rid, t.${col} AS ts,
           CASE t.kind
             WHEN 'person' THEN (SELECT name FROM people WHERE id = t.item_id)
             WHEN 'project' THEN (SELECT title FROM projects WHERE id = t.item_id AND deleted_at IS NULL)
             WHEN 'note' THEN (SELECT title FROM notes WHERE id = t.item_id AND deleted_at IS NULL)
             WHEN 'meeting' THEN (SELECT '1-1 ' || p.name || ' ' || substr(m.started_at, 1, 10)
                                  FROM meetings m JOIN people p ON p.id = m.person_id WHERE m.id = t.item_id)
           END AS title,
           CASE t.kind
             WHEN 'person' THEN (SELECT archived_at IS NOT NULL FROM people WHERE id = t.item_id)
             WHEN 'meeting' THEN (SELECT p.archived_at IS NOT NULL FROM meetings m JOIN people p ON p.id = m.person_id WHERE m.id = t.item_id)
             ELSE 0
           END AS archived
         FROM ${table} t
       ) WHERE title IS NOT NULL ORDER BY ts ${dir}, rid ${dir} LIMIT ?`,
    )
    .all(limit) as unknown as Row[];
  return rows.map((r) => ({ kind: r.kind, id: r.item_id, title: r.title ?? '', archived: Boolean(r.archived) }));
}

/** Pinned items (oldest pin first) and recents (newest first, max `LIMITS.recents`). Dead items are hidden. */
export function getNav(db: DatabaseSync): NavResponse {
  return {
    pinned: listNav(db, 'pins', 'created_at', 'ASC', LIMITS.pins),
    recents: listNav(db, 'recents', 'opened_at', 'DESC', LIMITS.recents),
  };
}

/**
 * Idempotent pin. Returns 'missing' if the item does not exist, 'too_many' when it would be pin
 * number LIMITS.pins + 1 (an already pinned item never counts again), else 'ok'.
 */
export function pin(db: DatabaseSync, kind: PinKind, id: Id, now: Date): 'ok' | 'missing' | 'too_many' {
  if (!navItemExists(db, kind, id)) return 'missing';
  db.exec('BEGIN IMMEDIATE');
  try {
    const already = db.prepare('SELECT 1 FROM pins WHERE kind = ? AND item_id = ?').get(kind, id) !== undefined;
    if (!already) {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM pins').get() as unknown as { n: number }).n;
      if (n >= LIMITS.pins) { db.exec('ROLLBACK'); return 'too_many'; }
      db.prepare('INSERT INTO pins (kind, item_id, created_at) VALUES (?, ?, ?)').run(kind, id, now.toISOString());
    }
    db.exec('COMMIT');
    return 'ok';
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Idempotent unpin. Works for any id, so a pin on a vanished item can still be removed. */
export function unpin(db: DatabaseSync, kind: PinKind, id: Id): void {
  db.prepare('DELETE FROM pins WHERE kind = ? AND item_id = ?').run(kind, id);
}

/**
 * Record that the item was opened: moves it to the top, then trims to `LIMITS.recentsStored`.
 * Returns false if the item does not exist. INSERT OR REPLACE gives a fresh rowid, which breaks
 * timestamp ties in favour of the latest touch.
 */
export function touchRecent(db: DatabaseSync, kind: NavKind, id: Id, now: Date): boolean {
  if (!navItemExists(db, kind, id)) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR REPLACE INTO recents (kind, item_id, opened_at) VALUES (?, ?, ?)').run(kind, id, now.toISOString());
    db.prepare(
      `DELETE FROM recents WHERE rowid NOT IN (
         SELECT rowid FROM recents ORDER BY opened_at DESC, rowid DESC LIMIT ?)`,
    ).run(LIMITS.recentsStored);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
