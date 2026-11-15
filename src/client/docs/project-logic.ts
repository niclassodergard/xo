import type { Id, Person, ProjectStatus } from '../../shared/types.ts';
import type { ProjectSummary } from '../../shared/api.ts';

// Pure helpers for the Projects list and the Project document.

export const STATUS_ORDER: ProjectStatus[] = ['active', 'on_hold', 'done'];
export const STATUS_LABEL: Record<ProjectStatus, string> = { active: 'Active', on_hold: 'On hold', done: 'Done' };

export interface ProjectGroup { status: ProjectStatus; label: string; items: ProjectSummary[] }

/**
 * Groups projects as Active / On hold / Done, always all three groups in that order (possibly empty).
 * Within a group the incoming order (the server sorts by title) is kept.
 */
export function groupProjects(items: ProjectSummary[]): ProjectGroup[] {
  return STATUS_ORDER.map((status) => ({ status, label: STATUS_LABEL[status], items: items.filter((p) => p.status === status) }));
}

/** "3 open" / "1 open" / "" (no open actions): shown next to the title. */
export function openCountLabel(n: number): string {
  return n > 0 ? `${n} open` : '';
}

/** Whether an unknown value from a <select> is a project status. */
export function isStatus(v: string): v is ProjectStatus {
  return (STATUS_ORDER as string[]).includes(v);
}

/** The linked people after adding `person` (no duplicate), kept sorted by name (Swedish collation). */
export function addPerson(list: Person[], person: Person): Person[] {
  if (list.some((p) => p.id === person.id)) return list;
  return [...list, person].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
}

/** The linked people without the one with `id`. */
export function removePerson(list: Person[], id: Id): Person[] {
  return list.filter((p) => p.id !== id);
}

/** Whether the aliases text differs from the stored aliases (after parsing), so a no-op save can be skipped. */
export function sameAliases(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
