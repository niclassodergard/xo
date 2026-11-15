import type { Id } from '../../shared/types.ts';

// Pure text/date helpers shared by the stream and the documents (copied from the v0.1 logic files).

const two = (n: number) => String(n).padStart(2, '0');

/** Local time of day, "14:30"; '' for an unparseable value. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The YYYY-MM-DD prefix of an ISO string, '' when it does not look like one. */
export function shortDate(iso: string): string { return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : ''; }

/** Local date and time, "2026-11-15 14:30". Anything unparseable is shown as-is (never throws). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function formatDay(iso: string): string {
  return formatWhen(iso).slice(0, 10);
}

/** One line of text for lists: whitespace collapsed, cut at `max` characters (default: no cut). */
export function oneLine(text: string, max?: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return max !== undefined && s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Aliases typed as "Ann, Annie" -> ['Ann','Annie'] (trimmed, blanks and case-insensitive duplicates removed). */
export function parseAliases(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of input.split(',')) {
    const a = part.trim();
    const key = a.normalize('NFC').toLowerCase();
    if (a === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function formatAliases(aliases: string[]): string {
  return aliases.join(', ');
}

/** Whether more pages may exist: a full page came back. */
export function mayHaveMore(received: number, pageSize: number): boolean {
  return received >= pageSize;
}

/** Appends an older page after the current items, skipping ids already present. */
export function appendPage<T extends { id: Id }>(items: T[], page: T[]): T[] {
  const have = new Set(items.map((i) => i.id));
  return [...items, ...page.filter((p) => !have.has(p.id))];
}

/** Oldest (smallest) id of a list, for "before=" paging. */
export function oldestId(items: { id: Id }[]): Id | undefined {
  let min: Id | undefined;
  for (const i of items) if (min === undefined || i.id < min) min = i.id;
  return min;
}
