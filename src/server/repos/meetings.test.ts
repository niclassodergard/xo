import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { createAction, softDeleteAction } from './actions.ts';
import { createAgendaItem, updateAgendaItem } from './agenda.ts';
import { endMeeting, getMeetingDetail, startMeeting, updateMeetingNotes } from './meetings.ts';
import { createPerson, getPersonDetail } from './people.ts';

const at = (n: number): Date => new Date(Date.UTC(2026, 0, n, 10));
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

describe('meetings repo', () => {
  it('runs the 1-1 loop with carry-over and previous meeting', () => {
    const p = createPerson(db, { name: 'Anna' }, at(1));
    const [a, b, c] = ['a', 'b', 'c'].map((t) => createAgendaItem(db, { personId: p.id, text: t }, at(1)));

    const m1 = startMeeting(db, p.id, at(2))!;
    expect(m1.openAgenda.map((i) => i.text)).toEqual(['a', 'b', 'c']);
    expect(m1.previous).toBeNull();
    expect(getPersonDetail(db, p.id)!.activeMeetingId).toBe(m1.meeting.id);

    updateAgendaItem(db, a!.id, { status: 'done', meetingId: m1.meeting.id }, at(2));
    const mine = createAction(db, { text: 'send budget', owner: 'me', personId: p.id, meetingId: m1.meeting.id }, at(2));
    const theirs = createAction(db, { text: 'share plan', owner: 'them', personId: p.id, meetingId: m1.meeting.id }, at(2));
    const elsewhere = createAction(db, { text: 'older', personId: p.id }, at(1));
    updateMeetingNotes(db, m1.meeting.id, 'discussed budget');

    const mid = getMeetingDetail(db, m1.meeting.id)!;
    expect(mid.openAgenda.map((i) => i.id)).toEqual([b!.id, c!.id]);
    expect(mid.resolvedHere.map((i) => i.id)).toEqual([a!.id]);
    expect(mid.actionsHere.map((x) => x.id)).toEqual([mine.id, theirs.id]);
    expect(mid.otherOpenActions.map((x) => x.id)).toEqual([elsewhere.id]);

    const ended = endMeeting(db, m1.meeting.id, at(3))!;
    expect(ended.endedAt).toBe(at(3).toISOString());
    expect(endMeeting(db, m1.meeting.id, at(9))!.endedAt).toBe(at(3).toISOString());
    expect(getPersonDetail(db, p.id)!.activeMeetingId).toBeNull();

    const m2 = startMeeting(db, p.id, at(10))!;
    expect(m2.meeting.id).not.toBe(m1.meeting.id);
    expect(m2.openAgenda.map((i) => i.id)).toEqual([b!.id, c!.id]);
    expect(m2.previous!.meeting.notesMd).toBe('discussed budget');
    expect(m2.previous!.resolved.map((i) => i.id)).toEqual([a!.id]);
    expect(m2.previous!.actions.map((x) => x.id)).toEqual([mine.id, theirs.id]);
    // the previous meeting's follow-ups are still open actions for the person
    expect(m2.otherOpenActions.map((x) => x.id)).toEqual([mine.id, theirs.id, elsewhere.id]);

    softDeleteAction(db, mine.id, at(11));
    expect(getMeetingDetail(db, m2.meeting.id)!.previous!.actions.map((x) => x.id)).toEqual([theirs.id]);
  });

  it('returns the active meeting instead of creating a second one', () => {
    const p = createPerson(db, { name: 'Anna' }, at(1));
    const m1 = startMeeting(db, p.id, at(2))!;
    const again = startMeeting(db, p.id, at(3))!;
    expect(again.meeting.id).toBe(m1.meeting.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM meetings').get()).toEqual({ n: 1 });
  });

  it('returns null for unknown people and meetings', () => {
    expect(startMeeting(db, 42, at(1))).toBeNull();
    expect(getMeetingDetail(db, 42)).toBeNull();
    expect(updateMeetingNotes(db, 42, 'x')).toBeNull();
    expect(endMeeting(db, 42, at(1))).toBeNull();
  });

  it('only shows items belonging to the meeting person (defence in depth)', () => {
    const anna = createPerson(db, { name: 'Anna' }, at(1));
    const bob = createPerson(db, { name: 'Bob' }, at(1));
    const m = startMeeting(db, anna.id, at(2))!;
    const foreignItem = createAgendaItem(db, { personId: bob.id, text: 'bobs' }, at(2));
    updateAgendaItem(db, foreignItem.id, { status: 'done', meetingId: m.meeting.id }, at(2));
    createAction(db, { text: 'bobs action', personId: bob.id, meetingId: m.meeting.id }, at(2));
    createAction(db, { text: 'orphan', meetingId: m.meeting.id }, at(2));
    const d = getMeetingDetail(db, m.meeting.id)!;
    expect(d.resolvedHere).toEqual([]);
    expect(d.actionsHere).toEqual([]);
  });
});
