import type { DatabaseSync } from 'node:sqlite';
import { LIMITS } from '../../shared/api.ts';
import type { ProjectDetailResponse, ProjectSummary } from '../../shared/api.ts';
import type { Action, Id, Person, Project, ProjectStatus } from '../../shared/types.ts';
import { mapAction } from './actions.ts';
import { scrubProjectFromCaptures } from './captures.ts';
import { listNoteSummaries } from './notes.ts';
import { mapPerson, normalizeAliases } from './people.ts';

interface ProjectRow {
  id: number; title: string; aliases: string; status: ProjectStatus; description_md: string;
  created_at: string; updated_at: string; deleted_at: string | null;
}

function parseAliases(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

export function mapProject(r: ProjectRow): Project {
  return {
    id: r.id, title: r.title, aliases: parseAliases(r.aliases), status: r.status, descriptionMd: r.description_md,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const STATUS_ORDER: Record<ProjectStatus, number> = { active: 0, on_hold: 1, done: 2 };
const collate = (a: string, b: string): number => a.localeCompare(b, 'sv', { sensitivity: 'base' });

/** Active, on hold, done; then title (Swedish collation); ties by id. */
export function listProjects(db: DatabaseSync, opts: { status?: ProjectStatus | 'all' } = {}): ProjectSummary[] {
  const status = opts.status ?? 'all';
  const rows = db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM actions a WHERE a.project_id = p.id AND a.status = 'open' AND a.deleted_at IS NULL) AS open_actions
       FROM projects p WHERE p.deleted_at IS NULL${status !== 'all' ? ' AND p.status = ?' : ''}`,
    )
    .all(...(status !== 'all' ? [status] : [])) as unknown as (ProjectRow & { open_actions: number })[];
  return rows
    .map((r) => ({
      id: r.id, title: r.title, aliases: parseAliases(r.aliases), status: r.status,
      openActions: r.open_actions, updatedAt: r.updated_at,
    }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || collate(a.title, b.title) || a.id - b.id);
}

/** Slim list for name matching: not deleted and not `done`, sorted by title. Callers cap what they send on. */
export function listProjectsForMatching(db: DatabaseSync): Pick<Project, 'id' | 'title' | 'aliases'>[] {
  const rows = db
    .prepare("SELECT id, title, aliases FROM projects WHERE deleted_at IS NULL AND status != 'done'")
    .all() as unknown as { id: number; title: string; aliases: string }[];
  return rows
    .map((r) => ({ id: r.id, title: r.title, aliases: parseAliases(r.aliases) }))
    .sort((a, b) => collate(a.title, b.title) || a.id - b.id);
}

export function getProject(db: DatabaseSync, id: Id): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as ProjectRow | undefined;
  return r ? mapProject(r) : null;
}

export function createProject(
  db: DatabaseSync,
  input: { title: string; aliases?: string[]; status?: ProjectStatus; descriptionMd?: string },
  now: Date,
): Project {
  const ts = now.toISOString();
  const res = db
    .prepare('INSERT INTO projects (title, aliases, status, description_md, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(input.title.trim(), JSON.stringify(normalizeAliases(input.aliases ?? [])), input.status ?? 'active', input.descriptionMd ?? '', ts, ts);
  return getProject(db, Number(res.lastInsertRowid))!;
}

export function updateProject(
  db: DatabaseSync,
  id: Id,
  patch: { title?: string; aliases?: string[]; status?: ProjectStatus; descriptionMd?: string },
  now: Date,
): Project | null {
  const cur = getProject(db, id);
  if (!cur) return null;
  db.prepare('UPDATE projects SET title = ?, aliases = ?, status = ?, description_md = ?, updated_at = ? WHERE id = ?').run(
    patch.title !== undefined ? patch.title.trim() : cur.title,
    JSON.stringify(patch.aliases !== undefined ? normalizeAliases(patch.aliases) : cur.aliases),
    patch.status ?? cur.status,
    patch.descriptionMd ?? cur.descriptionMd,
    now.toISOString(),
    id,
  );
  return getProject(db, id);
}

/** Runs `fn` in a transaction unless the caller already holds one. */
function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Soft delete (plan 4.7), one transaction: marks the project deleted, keeps its actions and notes
 * without a project, removes its person links, pins and recents, and scrubs chat captures.
 */
export function softDeleteProject(db: DatabaseSync, id: Id, now: Date): boolean {
  return inTransaction(db, () => {
    const ts = now.toISOString();
    const res = db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').run(ts, ts, id);
    if (Number(res.changes) === 0) return false;
    db.prepare('UPDATE actions SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('UPDATE notes SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM project_people WHERE project_id = ?').run(id);
    db.prepare("DELETE FROM pins WHERE kind = 'project' AND item_id = ?").run(id);
    db.prepare("DELETE FROM recents WHERE kind = 'project' AND item_id = ?").run(id);
    scrubProjectFromCaptures(db, id, now);
    return true;
  });
}

/** People linked to a project (archived people included), sorted by name. */
export function listProjectPeople(db: DatabaseSync, projectId: Id): Person[] {
  const rows = db
    .prepare('SELECT p.* FROM people p JOIN project_people pp ON pp.person_id = p.id WHERE pp.project_id = ?')
    .all(projectId) as unknown as Parameters<typeof mapPerson>[0][];
  return rows.map(mapPerson).sort((a, b) => collate(a.name, b.name) || a.id - b.id);
}

/** Detail for the API: all open actions, latest 50 done actions, latest 50 note previews. */
export function getProjectDetail(db: DatabaseSync, id: Id): ProjectDetailResponse | null {
  const project = getProject(db, id);
  if (!project) return null;
  const openActions: Action[] = (
    db
      .prepare("SELECT * FROM actions WHERE project_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY id")
      .all(id) as unknown as Parameters<typeof mapAction>[0][]
  ).map(mapAction);
  const doneActions: Action[] = (
    db
      .prepare("SELECT * FROM actions WHERE project_id = ? AND status = 'done' AND deleted_at IS NULL ORDER BY done_at DESC, id DESC LIMIT ?")
      .all(id, LIMITS.projectActionsDone) as unknown as Parameters<typeof mapAction>[0][]
  ).map(mapAction);
  return {
    project, people: listProjectPeople(db, id), openActions, doneActions,
    notes: listNoteSummaries(db, { projectId: id, limit: LIMITS.projectNotes }),
  };
}

/** Idempotent. Returns false when the project (live) or the person does not exist. */
export function linkPerson(db: DatabaseSync, projectId: Id, personId: Id, now: Date): boolean {
  if (!getProject(db, projectId)) return false;
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) return false;
  db.prepare('INSERT OR IGNORE INTO project_people (project_id, person_id, created_at) VALUES (?, ?, ?)').run(projectId, personId, now.toISOString());
  return true;
}

/** Idempotent. Returns false when the project (live) or the person does not exist. */
export function unlinkPerson(db: DatabaseSync, projectId: Id, personId: Id): boolean {
  if (!getProject(db, projectId)) return false;
  if (!db.prepare('SELECT 1 FROM people WHERE id = ?').get(personId)) return false;
  db.prepare('DELETE FROM project_people WHERE project_id = ? AND person_id = ?').run(projectId, personId);
  return true;
}
