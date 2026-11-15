import type { Id } from '../../shared/types.ts';
import type { TouchRecentRequest } from '../../shared/api.ts';
import { api } from './api.ts';
import { focusTarget } from './focus.ts';
import { typedSince } from './keys.ts';
import { navigate } from './router.ts';
import { epoch, errorText, flash, nav, personName, projectTitle, refreshNav, session, setNavOptimistic } from './store.ts';

export type DocRef =
  | { kind: 'person' | 'project' | 'meeting' | 'note'; id: Id }
  | { kind: 'actions' | 'notes' | 'people' | 'projects' };

const SEGMENT = { person: 'people', project: 'projects', meeting: 'meetings', note: 'notes' } as const;

/** Route path (without '#') of a document. Ids are integers, so nothing needs encoding. */
export function docPath(ref: DocRef): string {
  if ('id' in ref) return `/${SEGMENT[ref.kind]}/${Math.trunc(ref.id)}`;
  return `/${ref.kind}`;
}

/**
 * The only way user actions open a document (clicks, Enter, palette, voice). Navigates, records the document
 * as a recent (person, project, meeting, note) and moves focus into the panel (`focus: false` to leave focus
 * alone). A route load alone never records a recent: that would be a state-changing request caused by a page
 * load, so every in-app link must come through this function.
 */
export function openDoc(ref: DocRef, opts: { focus?: boolean } = {}): void {
  navigate(docPath(ref));
  if (opts.focus !== false) focusTarget('panel');
  if ('id' in ref) void recordRecent({ kind: ref.kind, id: ref.id });
}

/** Tell the server this document was opened, then reload the sidebar lists. Silent on failure (a convenience only). */
export async function recordRecent(body: TouchRecentRequest): Promise<void> {
  if (session.peek() === null) return;
  const e = epoch();
  try {
    await api.post('/api/nav/recents', body);
  } catch { return; }
  if (e === epoch()) await refreshNav();
}

/**
 * Open a document as the result of an async request. `mark` is `keystrokeMark()` taken before the await: when the
 * user typed since, the document still opens but focus is left alone. Commands and voice use this.
 */
export function openDocAsync(ref: DocRef, mark: number): void {
  openDoc(ref, { focus: !typedSince(mark) });
}

/** Whether a person or project is pinned (from the loaded nav lists). */
export function isPinned(kind: 'person' | 'project', id: Id): boolean {
  return nav.value.pinned.some((p) => p.kind === kind && p.id === id);
}

const pinsInFlight = new Set<string>();

/**
 * Pin or unpin on the server. The in-flight guard is checked BEFORE the optimistic change, so a fast second
 * press neither flips the UI nor sends a request. On failure the previous lists come back and a message shows.
 */
export async function togglePin(kind: 'person' | 'project', id: Id): Promise<void> {
  const key = `${kind}:${id}`;
  if (pinsInFlight.has(key)) return;
  pinsInFlight.add(key);
  const e = epoch();
  const before = nav.peek();
  const was = isPinned(kind, id);
  if (was) {
    setNavOptimistic({ ...before, pinned: before.pinned.filter((p) => !(p.kind === kind && p.id === id)) });
  } else {
    const title = kind === 'person' ? personName(id) : projectTitle(id);
    if (title !== null) setNavOptimistic({ ...before, pinned: [...before.pinned, { kind, id, title, archived: false }] });
  }
  const path = `/api/nav/pins/${kind}/${Math.trunc(id)}`;
  let failed: unknown = null;
  try {
    if (was) await api.del(path); else await api.put(path);
  } catch (err) {
    failed = err;
  } finally {
    pinsInFlight.delete(key);
  }
  if (e !== epoch()) return;
  if (failed !== null) {
    flash(`Could not ${was ? 'unpin' : 'pin'}: ${errorText(failed)}`, 'error');
    setNavOptimistic({ ...nav.peek(), pinned: before.pinned }); // only the pin lists: a recents refresh may have landed
  }
  await refreshNav();
}

/** The pinnable document of a route (person or project), else null. Used by the palette's Pin/Unpin command. */
export function pinTargetOf(r: { name: string; params: Record<string, string> }): { kind: 'person' | 'project'; id: Id } | null {
  const kind = r.name === 'person' ? 'person' : r.name === 'project' ? 'project' : null;
  const id = Number(r.params.id);
  return kind !== null && Number.isInteger(id) && id > 0 ? { kind, id } : null;
}
