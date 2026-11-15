import type { DatabaseSync } from 'node:sqlite';
import type { Action, Id, Owner } from '../../shared/types.ts';

interface ActionRow {
  id: number; text: string; owner: Owner; status: 'open' | 'done';
  person_id: number | null; meeting_id: number | null; project_id: number | null; created_at: string; done_at: string | null;
}

export function mapAction(r: ActionRow): Action {
  return {
    id: r.id, text: r.text, owner: r.owner, status: r.status, personId: r.person_id,
    meetingId: r.meeting_id, projectId: r.project_id, createdAt: r.created_at, doneAt: r.done_at,
  };
}

export class ProjectNotFoundError extends Error {
  constructor() { super('project not found'); this.name = 'ProjectNotFoundError'; }
}

/** Throws ProjectNotFoundError unless the project exists and is not soft-deleted. */
export function assertLiveProject(db: DatabaseSync, projectId: Id | null | undefined): void {
  if (projectId === null || projectId === undefined) return;
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId)) throw new ProjectNotFoundError();
}

export function listActions(
  db: DatabaseSync,
  opts: { status?: 'open' | 'done' | 'all'; owner?: Owner; personId?: Id; projectId?: Id | 'none'; limit?: number; before?: Id } = {},
): Action[] {
  const where = ['deleted_at IS NULL'];
  const params: (string | number)[] = [];
  const status = opts.status ?? 'open';
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (opts.owner !== undefined) { where.push('owner = ?'); params.push(opts.owner); }
  if (opts.personId !== undefined) { where.push('person_id = ?'); params.push(opts.personId); }
  if (opts.projectId === 'none') where.push('project_id IS NULL');
  else if (opts.projectId !== undefined) { where.push('project_id = ?'); params.push(opts.projectId); }
  if (opts.before !== undefined) { where.push('id < ?'); params.push(opts.before); }
  // Only fixed fragments are concatenated; every value is bound.
  const sql = `SELECT * FROM actions WHERE ${where.join(' AND ')} ORDER BY id DESC${opts.limit !== undefined ? ' LIMIT ?' : ''}`;
  if (opts.limit !== undefined) params.push(opts.limit);
  return (db.prepare(sql).all(...params) as unknown as ActionRow[]).map(mapAction);
}

export function getAction(db: DatabaseSync, id: Id): Action | null {
  const r = db.prepare('SELECT * FROM actions WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as ActionRow | undefined;
  return r ? mapAction(r) : null;
}

/** @throws ProjectNotFoundError when `projectId` names a missing or deleted project. */
export function createAction(
  db: DatabaseSync,
  input: { text: string; owner?: Owner; personId?: Id | null; meetingId?: Id | null; projectId?: Id | null },
  now: Date,
): Action {
  assertLiveProject(db, input.projectId);
  const res = db
    .prepare('INSERT INTO actions (text, owner, person_id, meeting_id, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.text, input.owner ?? 'me', input.personId ?? null, input.meetingId ?? null, input.projectId ?? null, now.toISOString());
  return getAction(db, Number(res.lastInsertRowid))!;
}

export function updateAction(
  db: DatabaseSync,
  id: Id,
  patch: { text?: string; owner?: Owner; status?: 'open' | 'done'; personId?: Id | null; projectId?: Id | null },
  now: Date,
): Action | null {
  const cur = getAction(db, id);
  if (!cur) return null;
  // Only a changed link is checked, so an item can still be edited after its project was deleted (link is already NULL then).
  if (patch.projectId !== undefined && patch.projectId !== cur.projectId) assertLiveProject(db, patch.projectId);
  const status = patch.status ?? cur.status;
  let doneAt = cur.doneAt;
  if (status === 'open') doneAt = null;
  else if (cur.status !== 'done') doneAt = now.toISOString();
  db.prepare('UPDATE actions SET text = ?, owner = ?, status = ?, person_id = ?, project_id = ?, done_at = ? WHERE id = ?').run(
    patch.text ?? cur.text,
    patch.owner ?? cur.owner,
    status,
    patch.personId !== undefined ? patch.personId : cur.personId,
    patch.projectId !== undefined ? patch.projectId : cur.projectId,
    doneAt,
    id,
  );
  return getAction(db, id);
}

export function softDeleteAction(db: DatabaseSync, id: Id, now: Date): boolean {
  const res = db.prepare('UPDATE actions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now.toISOString(), id);
  return Number(res.changes) > 0;
}
