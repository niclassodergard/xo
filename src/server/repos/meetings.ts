import type { DatabaseSync } from 'node:sqlite';
import type { Action, AgendaItem, Id, Meeting, MeetingDetail } from '../../shared/types.ts';
import { mapAction } from './actions.ts';
import { mapAgendaItem } from './agenda.ts';
import { getPerson } from './people.ts';

interface MeetingRow { id: number; person_id: number; started_at: string; ended_at: string | null; notes_md: string }

function mapMeeting(r: MeetingRow): Meeting {
  return { id: r.id, personId: r.person_id, startedAt: r.started_at, endedAt: r.ended_at, notesMd: r.notes_md };
}

export function getMeeting(db: DatabaseSync, id: Id): Meeting | null {
  const r = db.prepare('SELECT * FROM meetings WHERE id = ?').get(id) as unknown as MeetingRow | undefined;
  return r ? mapMeeting(r) : null;
}

function agendaRows(rows: unknown): AgendaItem[] {
  return (rows as Parameters<typeof mapAgendaItem>[0][]).map(mapAgendaItem);
}
function actionRows(rows: unknown): Action[] {
  return (rows as Parameters<typeof mapAction>[0][]).map(mapAction);
}

function resolvedIn(db: DatabaseSync, meetingId: Id, personId: Id): AgendaItem[] {
  return agendaRows(
    db
      .prepare("SELECT * FROM agenda_items WHERE resolved_meeting_id = ? AND person_id = ? AND status != 'open' AND deleted_at IS NULL ORDER BY resolved_at, id")
      .all(meetingId, personId),
  );
}

function actionsOf(db: DatabaseSync, meetingId: Id, personId: Id): Action[] {
  return actionRows(
    db.prepare('SELECT * FROM actions WHERE meeting_id = ? AND person_id = ? AND deleted_at IS NULL ORDER BY id').all(meetingId, personId),
  );
}

export function getMeetingDetail(db: DatabaseSync, id: Id): MeetingDetail | null {
  const meeting = getMeeting(db, id);
  if (!meeting) return null;
  const person = getPerson(db, meeting.personId);
  if (!person) return null;
  const openAgenda = agendaRows(
    db
      .prepare("SELECT * FROM agenda_items WHERE person_id = ? AND status = 'open' AND deleted_at IS NULL ORDER BY id")
      .all(meeting.personId),
  );
  const otherOpenActions = actionRows(
    db
      .prepare(
        "SELECT * FROM actions WHERE person_id = ? AND status = 'open' AND deleted_at IS NULL AND (meeting_id IS NULL OR meeting_id != ?) ORDER BY id",
      )
      .all(meeting.personId, id),
  );
  const prevRow = db
    .prepare('SELECT * FROM meetings WHERE person_id = ? AND id < ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1')
    .get(meeting.personId, id) as unknown as MeetingRow | undefined;
  const previous = prevRow
    ? { meeting: mapMeeting(prevRow), resolved: resolvedIn(db, prevRow.id, prevRow.person_id), actions: actionsOf(db, prevRow.id, prevRow.person_id) }
    : null;
  return {
    meeting, person, openAgenda, resolvedHere: resolvedIn(db, id, meeting.personId),
    actionsHere: actionsOf(db, id, meeting.personId), otherOpenActions, previous,
  };
}

/** Starts a meeting, or returns the one already in progress for that person. Null if no such person. */
export function startMeeting(db: DatabaseSync, personId: Id, now: Date): MeetingDetail | null {
  if (!getPerson(db, personId)) return null;
  const active = db
    .prepare('SELECT id FROM meetings WHERE person_id = ? AND ended_at IS NULL')
    .get(personId) as unknown as { id: number } | undefined;
  if (active) return getMeetingDetail(db, active.id);
  const res = db.prepare('INSERT INTO meetings (person_id, started_at) VALUES (?, ?)').run(personId, now.toISOString());
  return getMeetingDetail(db, Number(res.lastInsertRowid));
}

/** True when a meeting is already in progress for this person (used to pick the status code). */
export function hasActiveMeeting(db: DatabaseSync, personId: Id): boolean {
  return db.prepare('SELECT 1 FROM meetings WHERE person_id = ? AND ended_at IS NULL').get(personId) !== undefined;
}

export function updateMeetingNotes(db: DatabaseSync, id: Id, notesMd: string): Meeting | null {
  db.prepare('UPDATE meetings SET notes_md = ? WHERE id = ?').run(notesMd, id);
  return getMeeting(db, id);
}

/** Idempotent: ending an ended meeting leaves its end time unchanged. */
export function endMeeting(db: DatabaseSync, id: Id, now: Date): Meeting | null {
  db.prepare('UPDATE meetings SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now.toISOString(), id);
  return getMeeting(db, id);
}
