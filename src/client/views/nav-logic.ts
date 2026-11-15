// Pure helper for the global ←/→ view switch (kept out of app.tsx so it can be unit-tested in node).

export interface ViewEntry { href: string; names: string[] }

/**
 * The view reached by stepping `dir` from the route `current` through `entries` (Chat, Actions, Notes,
 * People), wrapping. Detail routes count as their section (note → Notes, person/meeting → People). From a route
 * that is in no section (Search, not found) → goes to the first entry and ← to the last.
 */
export function cycleView(entries: ViewEntry[], current: string, dir: 1 | -1): string {
  const n = entries.length;
  if (n === 0) return '/chat';
  const i = entries.findIndex((e) => e.names.includes(current));
  if (i < 0) return entries[dir === 1 ? 0 : n - 1]!.href;
  return entries[(((i + dir) % n) + n) % n]!.href;
}
