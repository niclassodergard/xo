import type { SearchHit } from '../../shared/api.ts';
import type { Id, Person } from '../../shared/types.ts';
import type { ProjectSummary } from '../../shared/api.ts';
import type { DocRef } from './nav.ts';

// Pure logic of the search palette (components/Palette.tsx): result groups, ordering and the mapping of
// a result to the document it opens, plus the debounce and stale-response rules of the server search.

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_LIMIT = 20;
/** At most this many local name matches per kind. */
export const LOCAL_PER_KIND = 5;

const fold = (s: string) => s.normalize('NFC').toLowerCase();

/** Whether the server should be asked: enough characters after trimming. */
export function shouldSearch(query: string): boolean {
  return query.trim().length >= SEARCH_MIN_CHARS;
}

/** The document a server search hit opens. Actions and agenda items have no page of their own: their person. */
export function hitToRef(hit: Pick<SearchHit, 'kind' | 'id' | 'personId'>): DocRef {
  switch (hit.kind) {
    case 'note': return { kind: 'note', id: hit.id };
    case 'person': return { kind: 'person', id: hit.id };
    case 'project': return { kind: 'project', id: hit.id };
    case 'meeting': return { kind: 'meeting', id: hit.id };
    case 'agenda': return hit.personId !== null ? { kind: 'person', id: hit.personId } : { kind: 'people' };
    case 'action': return hit.personId !== null ? { kind: 'person', id: hit.personId } : { kind: 'actions' };
  }
}

export type HitKind = SearchHit['kind'];
export const KIND_LABEL: Record<HitKind, string> = {
  note: 'Note', action: 'Action', agenda: 'Agenda', person: 'Person', meeting: '1-1', project: 'Project',
};

export interface LocalMatch { kind: 'person' | 'project'; id: Id; title: string; archived: boolean }

/** People (not archived first) and projects whose name or an alias contains the query; max LOCAL_PER_KIND each. */
export function localMatches(
  query: string, people: Pick<Person, 'id' | 'name' | 'aliases' | 'archivedAt'>[], projects: Pick<ProjectSummary, 'id' | 'title' | 'aliases'>[],
): LocalMatch[] {
  const q = fold(query.trim());
  if (!q) return [];
  const hit = (name: string, aliases: string[]) => fold(name).includes(q) || aliases.some((a) => fold(a).includes(q));
  // Names that start with the query come first, then the rest, each in list order.
  const rank = (name: string) => (fold(name).startsWith(q) ? 0 : 1);
  const ppl = people.filter((p) => hit(p.name, p.aliases))
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || rank(a.name) - rank(b.name))
    .slice(0, LOCAL_PER_KIND)
    .map((p): LocalMatch => ({ kind: 'person', id: p.id, title: p.name, archived: p.archivedAt !== null }));
  const prj = projects.filter((p) => hit(p.title, p.aliases))
    .sort((a, b) => rank(a.title) - rank(b.title))
    .slice(0, LOCAL_PER_KIND)
    .map((p): LocalMatch => ({ kind: 'project', id: p.id, title: p.title, archived: false }));
  return [...ppl, ...prj];
}

export type PaletteGroup = 'commands' | 'names' | 'search';
export type PaletteRow =
  | { group: 'commands'; key: string; title: string; commandId: string }
  | { group: 'names' | 'search'; key: string; title: string; sub: string; ref: DocRef };

export const GROUP_TITLE: Record<PaletteGroup, string> = { commands: 'Commands', names: 'People and projects', search: 'Search results' };

/**
 * One flat, ordered row list (Up/Down walks across the groups): commands, then names, then server hits.
 * A server hit that points at a person or project already listed under names is dropped.
 */
export function buildRows(
  commands: { id: string; title: string }[], names: LocalMatch[], hits: SearchHit[],
): PaletteRow[] {
  const rows: PaletteRow[] = commands.map((c) => ({ group: 'commands', key: `cmd:${c.id}`, title: c.title, commandId: c.id }));
  const listed = new Set(names.map((n) => `${n.kind}:${n.id}`));
  for (const n of names) {
    rows.push({ group: 'names', key: `name:${n.kind}:${n.id}`, title: n.title, sub: n.kind === 'person' ? (n.archived ? 'Person, archived' : 'Person') : 'Project', ref: { kind: n.kind, id: n.id } });
  }
  for (const h of hits) {
    if ((h.kind === 'person' || h.kind === 'project') && listed.has(`${h.kind}:${h.id}`)) continue;
    const sub = [KIND_LABEL[h.kind] + (h.archived ? ' (archived)' : ''), h.snippet].filter(Boolean).join(' · ');
    rows.push({ group: 'search', key: `hit:${h.kind}:${h.id}`, title: h.title, sub, ref: hitToRef(h) });
  }
  return rows;
}

/** Index of the first row of each group present (for rendering group titles). */
export function groupStarts(rows: PaletteRow[]): Map<number, PaletteGroup> {
  const out = new Map<number, PaletteGroup>();
  let prev: PaletteGroup | null = null;
  rows.forEach((r, i) => { if (r.group !== prev) { out.set(i, r.group); prev = r.group; } });
  return out;
}

/** Keeps the selection on the same row when results change (server hits arriving); otherwise on the first row. */
export function reselect(prevKey: string | null, rows: PaletteRow[]): number {
  if (prevKey === null) return 0;
  const i = rows.findIndex((r) => r.key === prevKey);
  return i < 0 ? 0 : i;
}

/**
 * Stale-response rule for the server search: every request takes a ticket; a response is used only while
 * its ticket is the newest and the session epoch is the one it started in. `cancel` (query too short,
 * palette closed) makes every outstanding ticket stale.
 */
export function createSearchTickets(): { begin(epochNow: number): number; isCurrent(ticket: number, epochNow: number): boolean; cancel(): void } {
  let latest = 0;
  let startedEpoch = -1;
  return {
    begin(epochNow) { startedEpoch = epochNow; return ++latest; },
    isCurrent(ticket, epochNow) { return ticket === latest && epochNow === startedEpoch; },
    cancel() { latest++; },
  };
}
