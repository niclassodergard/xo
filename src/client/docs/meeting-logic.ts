import type { Action, AgendaItem, Id, Meeting, MeetingDetail, Person } from '../../shared/types.ts';

// Pure helpers for the Person and Meeting documents (no DOM, no signals), so they run under Vitest in node.
// Date, text, alias and paging helpers live in lib/format.ts; grouping and ordering of actions in actions-logic.ts.

/** Agenda items in creation order. Open and resolved items interleave, so checking a row never moves it. */
export function mergeAgenda(open: AgendaItem[], resolved: AgendaItem[]): AgendaItem[] {
  const byId = new Map<Id, AgendaItem>();
  for (const it of open) byId.set(it.id, it);
  for (const it of resolved) byId.set(it.id, it); // resolved wins if an id is ever in both
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export type PreviousMeeting = MeetingDetail['previous'];

/** What the Meeting document renders; the open agenda is only meaningful while the meeting is active. */
export interface MeetingView {
  meeting: Meeting;
  person: Person;
  active: boolean;
  agenda: AgendaItem[];
  /** Follow-ups captured in this meeting. */
  here: Action[];
  /** Other open actions for this person, across projects (only for an active meeting). */
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

export function splitByOwner(actions: Action[]): { mine: Action[]; theirs: Action[] } {
  return { mine: actions.filter((a) => a.owner === 'me'), theirs: actions.filter((a) => a.owner === 'them') };
}

/** The owner an action row shows. */
export function ownerLabel(owner: Action['owner']): string {
  return owner === 'me' ? 'Me' : 'Them';
}

/** "3/5" style summary of the agenda (items no longer open / all items). */
export function agendaProgress(items: Pick<AgendaItem, 'status'>[]): string {
  const done = items.filter((i) => i.status !== 'open').length;
  return `${done}/${items.length}`;
}
