import type { DatabaseSync } from 'node:sqlite';
import type { AgendaItem, Id } from '../../shared/types.ts';

interface AgendaRow {
  id: number; person_id: number; text: string; status: AgendaItem['status'];
  created_at: string; resolved_at: string | null; resolved_meeting_id: number | null;
}

export function mapAgendaItem(r: AgendaRow): AgendaItem {
  return {
    id: r.id, personId: r.person_id, text: r.text, status: r.status, createdAt: r.created_at,
    resolvedAt: r.resolved_at, resolvedMeetingId: r.resolved_meeting_id,
  };
}

export function getAgendaItem(db: DatabaseSync, id: Id): AgendaItem | null {
  const r = db.prepare('SELECT * FROM agenda_items WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as AgendaRow | undefined;
  return r ? mapAgendaItem(r) : null;
}

export function createAgendaItem(db: DatabaseSync, input: { personId: Id; text: string }, now: Date): AgendaItem {
  const res = db
    .prepare('INSERT INTO agenda_items (person_id, text, created_at) VALUES (?, ?, ?)')
    .run(input.personId, input.text, now.toISOString());
  return getAgendaItem(db, Number(res.lastInsertRowid))!;
}

/**
 * `status:'done'|'dropped'` records resolution (time, and the meeting when `meetingId` is given);
 * `status:'open'` clears it. `meetingId` alone changes nothing.
 */
export function updateAgendaItem(
  db: DatabaseSync,
  id: Id,
  patch: { text?: string; status?: AgendaItem['status']; meetingId?: Id },
  now: Date,
): AgendaItem | null {
  const cur = getAgendaItem(db, id);
  if (!cur) return null;
  let { status, resolvedAt, resolvedMeetingId } = cur;
  if (patch.status === 'open') {
    status = 'open'; resolvedAt = null; resolvedMeetingId = null;
  } else if (patch.status !== undefined) {
    status = patch.status;
    resolvedAt = cur.status === 'open' ? now.toISOString() : (cur.resolvedAt ?? now.toISOString());
    resolvedMeetingId = patch.meetingId ?? (cur.status === 'open' ? null : cur.resolvedMeetingId);
  }
  db.prepare('UPDATE agenda_items SET text = ?, status = ?, resolved_at = ?, resolved_meeting_id = ? WHERE id = ?').run(
    patch.text ?? cur.text, status, resolvedAt, resolvedMeetingId, id,
  );
  return getAgendaItem(db, id);
}

export function softDeleteAgendaItem(db: DatabaseSync, id: Id, now: Date): boolean {
  const res = db.prepare('UPDATE agenda_items SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now.toISOString(), id);
  return Number(res.changes) > 0;
}
