import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';

// Hash router: #/ (home), #/actions, #/notes, #/people, #/projects, and #/notes/:id, #/people/:id,
// #/projects/:id, #/meetings/:id. Legacy #/chat and #/search map to home. There is no query string:
// search text lives in client state, never in the URL.

export type RouteName =
  'home' | 'actions' | 'notes' | 'note' | 'people' | 'person' | 'projects' | 'project' | 'meeting' | 'notfound';
export interface Route { name: RouteName; params: Record<string, string> }

const ID = /^\d{1,15}$/;
const LISTS = new Set(['actions', 'notes', 'people', 'projects']);
const DETAIL: Record<string, RouteName> = { notes: 'note', people: 'person', projects: 'project', meetings: 'meeting' };

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** Parse a location hash ('#/people/3') or a path ('/people/3'). Unknown paths give name 'notfound'. */
export function parseRoute(input: string): Route {
  const s = input.startsWith('#') ? input.slice(1) : input;
  const segs = s.split('/').filter((x) => x !== '').map(decode);
  const notFound: Route = { name: 'notfound', params: {} };
  if (segs.some((x) => x === null)) return notFound;
  const [a, b, ...rest] = segs as string[];
  if (a === undefined) return { name: 'home', params: {} };
  if (rest.length > 0) return notFound;
  if (b === undefined) {
    if (a === 'chat' || a === 'search') return { name: 'home', params: {} };
    return LISTS.has(a) ? { name: a as RouteName, params: {} } : notFound;
  }
  // Ids are validated here so documents can put them into API paths safely.
  const detail = DETAIL[a];
  if (!detail || !ID.test(b)) return notFound;
  return { name: detail, params: { id: b } };
}

const BASE: Partial<Record<RouteName, string>> = {
  actions: '/actions', notes: '/notes', people: '/people', projects: '/projects',
  note: '/notes', person: '/people', project: '/projects', meeting: '/meetings',
};

/** Path (without '#') for a route; the inverse of parseRoute. */
export function formatRoute(r: { name: RouteName; params?: Record<string, string> }): string {
  const base = BASE[r.name];
  if (base === undefined) return '/';
  const id = r.params?.['id'];
  return id !== undefined ? `${base}/${encodeURIComponent(id)}` : base;
}

const PARENT: Partial<Record<RouteName, string>> = { note: '/notes', person: '/people', project: '/projects', meeting: '/people' };

/** The list a document belongs to, or home. */
export function parentPath(r: Route): string {
  return PARENT[r.name] ?? '/';
}

/** True when the route shows a document in the panel. */
export function isPanelRoute(r: Route): boolean {
  return r.name !== 'home';
}

/** back() uses history only when this app pushed an entry (depth > 0); otherwise it goes to the parent list. */
export function backAction(depth: number): 'history' | 'parent' {
  return depth > 0 ? 'history' : 'parent';
}

const hasWindow = typeof window !== 'undefined' && typeof window.location !== 'undefined';

function prevOf(state: unknown): string | null {
  const p = (state as { prev?: unknown } | null)?.prev;
  return typeof p === 'string' ? p : null;
}

function depthOf(state: unknown): number {
  const d = (state as { depth?: unknown } | null)?.depth;
  return typeof d === 'number' && Number.isInteger(d) && d > 0 ? d : 0;
}

export const route: Signal<Route> = signal<Route>(parseRoute(hasWindow ? window.location.hash : ''));

function sync(): void {
  const next = parseRoute(window.location.hash);
  if (JSON.stringify(next) !== JSON.stringify(route.value)) route.value = next;
}

if (hasWindow) {
  window.addEventListener('hashchange', sync);
  window.addEventListener('popstate', sync);
}

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const p = path.startsWith('/') ? path : `/${path}`;
  const parsed = parseRoute(p);
  const canonical = formatRoute(parsed.name === 'notfound' ? { name: 'home' } : parsed);
  if (!hasWindow) { route.value = parseRoute(canonical); return; }
  const hash = `#${canonical}`;
  if (window.location.hash !== hash) {
    const depth = depthOf(window.history.state);
    if (opts.replace) window.history.replaceState({ depth, prev: prevOf(window.history.state) }, '', hash);
    else window.history.pushState({ depth: depth + 1, prev: formatRoute(route.value) }, '', hash);
  }
  route.value = parseRoute(canonical);
}

export function back(): void {
  if (hasWindow && backAction(depthOf(window.history.state)) === 'history') window.history.back();
  else navigate(parentPath(route.value), { replace: true });
}

/** What closing the panel does for a given history state: go back when the entry just left was home, else replace. */
export function closeAction(state: unknown): 'history' | 'replace' {
  return depthOf(state) > 0 && prevOf(state) === '/' ? 'history' : 'replace';
}

/**
 * Close the open document (Esc, Close button). When the entry just left is home (stored in the pushed history
 * state) it uses history.back(); otherwise it replaces the current entry with home. Either way browser Back
 * never reopens the closed document.
 */
export function closePanel(): void {
  if (hasWindow && closeAction(window.history.state) === 'history') window.history.back();
  else navigate('/', { replace: true });
}
