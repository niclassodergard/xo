// Pure helpers for the "one interaction pattern": Up/Down pick a row, Left/Right pick one of that row's
// action chips, Enter runs it.

export interface RowAction {
  id: string;
  label: string;
  run: () => void | Promise<unknown>;
  /** Destructive: always goes through askConfirm before it runs. */
  danger?: boolean;
}

/**
 * Next highlighted chip for Left/Right (clamped, no wrap). With nothing highlighted (or a stale id) Right
 * picks the first chip and Left the last. null when the row has no chips.
 */
export function stepAction(ids: string[], current: string | null, dir: 'left' | 'right'): string | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i < 0) return dir === 'right' ? ids[0]! : ids[ids.length - 1]!;
  return ids[Math.min(Math.max(i + (dir === 'right' ? 1 : -1), 0), ids.length - 1)]!;
}

/** Index of the highlighted row after Up/Down; clamped. With no highlight Down picks the first and Up the last. */
export function stepRow(count: number, current: number, dir: 'up' | 'down'): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return dir === 'down' ? 0 : count - 1;
  return Math.min(Math.max(current + (dir === 'down' ? 1 : -1), 0), count - 1);
}
