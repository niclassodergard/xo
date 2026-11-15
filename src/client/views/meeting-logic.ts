import type { Action, AgendaItem, Id, Meeting, MeetingDetail, Person } from '../../shared/types.ts';

// Pure helpers for the Person and Meeting views (no DOM, no signals), so they run under Vitest in node.

/** Agenda items in creation order. Open and resolved items interleave, so checking a row never moves it. */
export function mergeAgenda(open: AgendaItem[], resolved: AgendaItem[]): AgendaItem[] {
  const byId = new Map<Id, AgendaItem>();
  for (const it of open) byId.set(it.id, it);
  for (const it of resolved) byId.set(it.id, it); // resolved wins if an id is ever in both
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export type PreviousMeeting = MeetingDetail['previous'];

/** What the Meeting view renders; the open agenda is only meaningful while the meeting is active. */
export interface MeetingView {
  meeting: Meeting;
  person: Person;
  active: boolean;
  agenda: AgendaItem[];
  /** Follow-ups captured in this meeting. */
  here: Action[];
  /** Other open actions for this person (only for an active meeting). */
  earlier: Action[];
  previous: PreviousMeeting;
}

export function isActive(m: Pick<Meeting, 'endedAt'>): boolean {
  return m.endedAt === null;
}

/**
 * An ended meeting shows only what was resolved in it: `openAgenda` is the person's agenda *now*
 * (the next meeting's agenda), not the state of that meeting.
 */
export function buildView(d: MeetingDetail): MeetingView {
  const active = isActive(d.meeting);
  return {
    meeting: d.meeting,
    person: d.person,
    active,
    agenda: active ? mergeAgenda(d.openAgenda, d.resolvedHere) : mergeAgenda([], d.resolvedHere),
    here: d.actionsHere,
    earlier: active ? d.otherOpenActions : [],
    previous: d.previous,
  };
}

/** Optimistic toggle: open -> done in this meeting, anything else -> open. Other items are untouched. */
export function toggleAgenda(items: AgendaItem[], id: Id, meetingId: Id, nowIso: string): AgendaItem[] {
  return items.map((it) => {
    if (it.id !== id) return it;
    return it.status === 'open'
      ? { ...it, status: 'done', resolvedAt: nowIso, resolvedMeetingId: meetingId }
      : { ...it, status: 'open', resolvedAt: null, resolvedMeetingId: null };
  });
}

/** The PATCH body that matches `toggleAgenda` for an item in its current state. */
export function toggleRequest(item: Pick<AgendaItem, 'status'>, meetingId: Id): { status: 'open' | 'done'; meetingId?: Id } {
  return item.status === 'open' ? { status: 'done', meetingId } : { status: 'open' };
}

export function replaceById<T extends { id: Id }>(items: T[], next: T): T[] {
  return items.some((it) => it.id === next.id) ? items.map((it) => (it.id === next.id ? next : it)) : [...items, next];
}

export function removeById<T extends { id: Id }>(items: T[], id: Id): T[] {
  return items.filter((it) => it.id !== id);
}

export interface ActionRow { action: Action; earlier: boolean }

/** This meeting's follow-ups first, then the person's other open actions. */
export function actionRows(here: Action[], earlier: Action[]): ActionRow[] {
  return [...here.map((action) => ({ action, earlier: false })), ...earlier.map((action) => ({ action, earlier: true }))];
}

export function splitByOwner(actions: Action[]): { mine: Action[]; theirs: Action[] } {
  return { mine: actions.filter((a) => a.owner === 'me'), theirs: actions.filter((a) => a.owner === 'them') };
}

/** Next pane index for Tab (dir 1) / Shift+Tab (dir -1), wrapping. */
export function cyclePane(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return 0;
  return (((current + dir) % count) + count) % count;
}

export function agendaMark(item: Pick<AgendaItem, 'status'>): string {
  return item.status === 'open' ? '[ ]' : item.status === 'done' ? '[x]' : '[-]';
}

/** "3/5 checked" style summary of the agenda. */
export function agendaProgress(items: Pick<AgendaItem, 'status'>[]): string {
  const done = items.filter((i) => i.status !== 'open').length;
  return `${done}/${items.length}`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** Local date and time, "2026-11-15 14:30". Anything unparseable is shown as-is (never throws). */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function formatDay(iso: string): string {
  return formatWhen(iso).slice(0, 10);
}

/** One line of text for lists: whitespace collapsed, cut at `max` characters. */
export function oneLine(text: string, max = 80): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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
