import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import type { NoteSummary } from '../../shared/api.ts';
import type { Id, Note } from '../../shared/types.ts';

interface NoteRow {
  id: number; title: string; body_md: string; person_id: number | null;
  created_at: string; updated_at: string;
}

export function mapNote(r: NoteRow): Note {
  return {
    id: r.id, title: r.title, bodyMd: r.body_md, personId: r.person_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toSummary(n: Note): NoteSummary {
  return {
    id: n.id, title: n.title, preview: Array.from(n.bodyMd).slice(0, LIMITS.notePreview).join(''),
    personId: n.personId, createdAt: n.createdAt, updatedAt: n.updatedAt,
  };
}

/** First non-empty line of the body, max 80 chars. */
export function defaultTitle(bodyMd: string): string {
  const line = bodyMd.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return line === '' ? 'Untitled' : Array.from(line).slice(0, 80).join('');
}

/** All live notes, full bodies, newest first (for export and internal use; routes use listNoteSummaries). */
export function listNotes(db: DatabaseSync, opts: { personId?: Id; limit?: number; before?: Id } = {}): Note[] {
  const where = ['deleted_at IS NULL'];
  const params: number[] = [];
  if (opts.personId !== undefined) { where.push('person_id = ?'); params.push(opts.personId); }
  if (opts.before !== undefined) { where.push('id < ?'); params.push(opts.before); }
  let sql = `SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY id DESC`;
  if (opts.limit !== undefined) { sql += ' LIMIT ?'; params.push(opts.limit); }
  return (db.prepare(sql).all(...params) as unknown as NoteRow[]).map(mapNote);
}

/** Bounded list with body previews (cut in SQL); `before` is an id cursor. */
export function listNoteSummaries(
  db: DatabaseSync,
  opts: { personId?: Id; limit?: number; before?: Id } = {},
): NoteSummary[] {
  const where = ['deleted_at IS NULL'];
  const params: number[] = [LIMITS.notePreview];
  if (opts.personId !== undefined) { where.push('person_id = ?'); params.push(opts.personId); }
  if (opts.before !== undefined) { where.push('id < ?'); params.push(opts.before); }
  params.push(opts.limit ?? 100);
  const rows = db
    .prepare(
      `SELECT id, title, substr(body_md, 1, ?) AS preview, person_id, created_at, updated_at
       FROM notes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as unknown as { id: number; title: string; preview: string; person_id: number | null; created_at: string; updated_at: string }[];
  return rows.map((r) => ({
    id: r.id, title: r.title, preview: r.preview, personId: r.person_id, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

export function getNote(db: DatabaseSync, id: Id): Note | null {
  const r = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as NoteRow | undefined;
  return r ? mapNote(r) : null;
}

export function createNote(
  db: DatabaseSync,
  input: { title?: string; bodyMd: string; personId?: Id | null },
  now: Date,
): Note {
  const ts = now.toISOString();
  const title = input.title !== undefined && input.title.trim() !== '' ? input.title.trim() : defaultTitle(input.bodyMd);
  const res = db
    .prepare('INSERT INTO notes (title, body_md, person_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(title, input.bodyMd, input.personId ?? null, ts, ts);
  return getNote(db, Number(res.lastInsertRowid))!;
}

export function updateNote(
  db: DatabaseSync,
  id: Id,
  patch: { title?: string; bodyMd?: string; personId?: Id | null },
  now: Date,
): Note | null {
  const cur = getNote(db, id);
  if (!cur) return null;
  const title = patch.title !== undefined && patch.title.trim() !== '' ? patch.title.trim() : cur.title;
  db.prepare('UPDATE notes SET title = ?, body_md = ?, person_id = ?, updated_at = ? WHERE id = ?').run(
    title,
    patch.bodyMd ?? cur.bodyMd,
    patch.personId !== undefined ? patch.personId : cur.personId,
    now.toISOString(),
    id,
  );
  return getNote(db, id);
}

export function softDeleteNote(db: DatabaseSync, id: Id, now: Date): boolean {
  const ts = now.toISOString();
  const res = db.prepare('UPDATE notes SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(ts, ts, id);
  return Number(res.changes) > 0;
}
