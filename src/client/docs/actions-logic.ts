import type { ProjectSummary } from '../../shared/api.ts';
import type { Action, Id, ProjectStatus } from '../../shared/types.ts';
import type { RowAction } from '../lib/row-actions.ts';

// Pure logic for the Actions document: grouping, ordering, person filter, optimistic updates, paging.

export interface ActionGroup {
  /** Stable key: `p<id>` or `none`. */
  key: string;
  /** null = the "No project" group. */
  projectId: Id | null;
  title: string;
  status: ProjectStatus | null;
  actions: Action[];
}

export const NO_PROJECT_TITLE = 'No project';
/** Done actions are paged by this; open actions are loaded at once (the route allows 200). */
export const PAGE_SIZE = 100;
export const OPEN_LIMIT = 200;

const collator = new Intl.Collator('sv', { sensitivity: 'base' });
const STATUS_ORDER: Record<ProjectStatus, number> = { active: 0, on_hold: 1, done: 2 };

/**
 * The one within-group order for every document: mine before waiting-for, then oldest first. There is no done
 * rank on purpose: checking a row off never moves it (a view that wants done rows apart filters, it does not sort).
 */
export function orderWithin(actions: Action[]): Action[] {
  return [...actions].sort((x, y) => (x.owner === y.owner ? 0 : x.owner === 'me' ? -1 : 1) || x.id - y.id);
}

/**
 * The one grouping for Actions, the 1-1 view and the Project doc: active projects by title (Swedish collation,
 * ties by id), then on hold, then done projects, then "No project". An action whose project is not in
 * `projects` (not loaded yet, deleted) is shown under "No project". Groups of projects without actions are
 * left out; "No project" is always there so there is always an add field. Actions are ordered by `orderWithin`.
 */
export function groupActionsByProject(actions: Action[], projects: ProjectSummary[]): ActionGroup[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  const buckets = new Map<Id | null, Action[]>();
  for (const a of actions) {
    const key = a.projectId !== null && byId.has(a.projectId) ? a.projectId : null;
    const list = buckets.get(key);
    if (list) list.push(a); else buckets.set(key, [a]);
  }
  const groups: ActionGroup[] = [];
  for (const [id, list] of buckets) {
    if (id === null) continue;
    const p = byId.get(id)!;
    groups.push({ key: `p${id}`, projectId: id, title: p.title, status: p.status, actions: orderWithin(list) });
  }
  groups.sort((a, b) => STATUS_ORDER[a.status!] - STATUS_ORDER[b.status!] || collator.compare(a.title, b.title) || a.projectId! - b.projectId!);
  groups.push({ key: 'none', projectId: null, title: NO_PROJECT_TITLE, status: null, actions: orderWithin(buckets.get(null) ?? []) });
  return groups;
}

export interface ActionRowHandlers {
  toggle: (a: Action) => void | Promise<unknown>;
  edit: (a: Action) => void | Promise<unknown>;
  pickProject: (a: Action) => void | Promise<unknown>;
  pickPerson: (a: Action) => void | Promise<unknown>;
  toggleOwner: (a: Action) => void | Promise<unknown>;
  remove: (a: Action) => void | Promise<unknown>;
}

/**
 * The row actions of an action in every document: Done/Reopen (default), Edit, Project… (only with
 * `withProject`), Person…, one owner chip that says what it does ("Mark waiting" / "Mark mine"), Delete (danger).
 */
export function actionRowActions(a: Action, h: ActionRowHandlers, opts: { withProject: boolean }): RowAction[] {
  return [
    { id: 'done', label: a.status === 'open' ? 'Done' : 'Reopen', run: () => h.toggle(a) },
    { id: 'edit', label: 'Edit', run: () => h.edit(a) },
    ...(opts.withProject ? [{ id: 'project', label: 'Project…', run: () => h.pickProject(a) }] : []),
    { id: 'person', label: 'Person…', run: () => h.pickPerson(a) },
    { id: 'owner', label: a.owner === 'me' ? 'Mark waiting' : 'Mark mine', run: () => h.toggleOwner(a) },
    { id: 'delete', label: 'Delete', danger: true, run: () => h.remove(a) },
  ];
}

/** Actions of one person; null keeps everything. */
export function filterByPerson(actions: Action[], personId: Id | null): Action[] {
  return personId === null ? actions : actions.filter((a) => a.personId === personId);
}

/** Without "Show done", done actions are not listed. */
export function filterByDone(actions: Action[], showDone: boolean): Action[] {
  return showDone ? actions : actions.filter((a) => a.status === 'open');
}

/** The list as it is shown: person filter and done toggle applied. */
export function visibleActions(actions: Action[], personId: Id | null, showDone: boolean): Action[] {
  return filterByDone(filterByPerson(actions, personId), showDone);
}

/** Replaces the action with the same id (a server result); unknown ids leave the list as it was. */
export function replaceAction(actions: Action[], next: Action): Action[] {
  return actions.some((a) => a.id === next.id) ? actions.map((a) => (a.id === next.id ? next : a)) : actions;
}

export function removeAction(actions: Action[], id: Id): Action[] {
  return actions.some((a) => a.id === id) ? actions.filter((a) => a.id !== id) : actions;
}

/** Adds a new action to the list's raw data (display order comes from `orderWithin`); an id already present is replaced instead. */
export function addAction(actions: Action[], created: Action): Action[] {
  return actions.some((a) => a.id === created.id) ? replaceAction(actions, created) : [created, ...actions];
}

export function toggledStatus(a: Pick<Action, 'status'>): 'open' | 'done' { return a.status === 'open' ? 'done' : 'open'; }

/**
 * Marks an action done or open in the list before the server has answered. The in-flight guard is checked
 * FIRST: when a request for this action is already running nothing changes and null is returned, so a fast
 * second key press can neither flip the UI nor send a request. Otherwise the id is added to `inflight` (the
 * caller removes it when the request ends) and the new list plus the previous action (for rollback) is returned.
 */
export function beginToggle(
  actions: Action[], id: Id, inflight: Set<Id>, nowIso: string,
): { actions: Action[]; previous: Action; status: 'open' | 'done' } | null {
  if (inflight.has(id)) return null;
  const previous = actions.find((a) => a.id === id);
  if (!previous) return null;
  inflight.add(id);
  const status = toggledStatus(previous);
  const next: Action = { ...previous, status, doneAt: status === 'done' ? nowIso : null };
  return { actions: replaceAction(actions, next), previous, status };
}

/** Query string of a list request: open actions (one request) or a page of done ones (newest first, `before` cursor). */
export function actionsQuery(opts: { status: 'open' | 'done'; personId: Id | null; before?: Id }): string {
  const q = new URLSearchParams();
  q.set('status', opts.status);
  if (opts.personId !== null) q.set('personId', String(opts.personId));
  q.set('limit', String(opts.status === 'open' ? OPEN_LIMIT : PAGE_SIZE));
  if (opts.before !== undefined) q.set('before', String(opts.before));
  return q.toString();
}
