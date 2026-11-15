import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';

// Hash router: #/chat, #/actions, #/notes, #/notes/:id, #/people, #/people/:id, #/meetings/:id, #/search.
// There is no query string: search text lives in client state (store.searchQuery), never in the URL.

export interface Route { name: string; params: Record<string, string> }

const ID = /^\d{1,15}$/;
const TOP = new Set(['chat', 'actions', 'notes', 'people', 'search']);

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
  if (a === undefined) return { name: 'chat', params: {} };
  if (rest.length > 0) return notFound;
  if (b === undefined) return TOP.has(a) ? { name: a, params: {} } : notFound;
  // Ids are validated here so views can put them into API paths safely.
  if (!ID.test(b)) return notFound;
  if (a === 'notes') return { name: 'note', params: { id: b } };
  if (a === 'people') return { name: 'person', params: { id: b } };
  if (a === 'meetings') return { name: 'meeting', params: { id: b } };
  return notFound;
}

const BASE: Record<string, string> = {
  chat: '/chat', actions: '/actions', notes: '/notes', people: '/people', search: '/search',
  note: '/notes', person: '/people', meeting: '/meetings',
};

/** Path (without '#') for a route; the inverse of parseRoute. */
export function formatRoute(r: { name: string; params?: Record<string, string> }): string {
  const base = BASE[r.name] ?? '/chat';
  const id = r.params?.id;
  return id !== undefined ? `${base}/${encodeURIComponent(id)}` : base;
}

const PARENT: Record<string, string> = { note: '/notes', person: '/people', meeting: '/people' };

export function parentPath(r: Route): string {
  return PARENT[r.name] ?? '/chat';
}

/** back() uses history only when this app pushed an entry (depth > 0); otherwise it goes to the parent view. */
export function backAction(depth: number): 'history' | 'parent' {
  return depth > 0 ? 'history' : 'parent';
}

const hasWindow = typeof window !== 'undefined' && typeof window.location !== 'undefined';

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
  const canonical = formatRoute(parsed.name === 'notfound' ? { name: 'chat' } : parsed);
  if (!hasWindow) { route.value = parseRoute(canonical); return; }
  const hash = `#${canonical}`;
  if (window.location.hash !== hash) {
    const depth = depthOf(window.history.state);
    if (opts.replace) window.history.replaceState({ depth }, '', hash);
    else window.history.pushState({ depth: depth + 1 }, '', hash);
  }
  route.value = parseRoute(canonical);
}

export function back(): void {
  if (hasWindow && backAction(depthOf(window.history.state)) === 'history') window.history.back();
  else navigate(parentPath(route.value), { replace: true });
}
