import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import actionsRoutes from './actions.ts';
import agendaRoutes from './agenda.ts';
import meetingsRoutes from './meetings.ts';
import notesRoutes from './notes.ts';
import peopleRoutes from './people.ts';
import searchRoutes from './search.ts';

type Opts = { deps: AppDeps };
async function all(app: FastifyInstance, opts: Opts): Promise<void> {
  for (const r of [peopleRoutes, notesRoutes, actionsRoutes, agendaRoutes, meetingsRoutes, searchRoutes]) {
    await app.register(r, { deps: opts.deps });
  }
}

let app: FastifyInstance;
let deps: AppDeps;
beforeEach(async () => {
  deps = makeDeps();
  app = await makeRouteApp(all, deps);
});
afterEach(async () => { await app.close(); });

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const text = res.body;
  return { status: res.statusCode, body: text ? (JSON.parse(text) as any) : null };
}
const mkPerson = async (name = 'Anna') => (await call('POST', '/api/people', { name })).body;

describe('people routes', () => {
  it('create, list, get, patch, archive', async () => {
    const created = await call('POST', '/api/people', { name: ' Anna ', aliases: ['Annie'] });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Anna', aliases: ['Annie'] });
    const id = created.body.id;

    expect((await call('GET', '/api/people')).body.people).toHaveLength(1);
    const detail = await call('GET', `/api/people/${id}`);
    expect(detail.body).toMatchObject({ person: { id }, openAgenda: [], activeMeetingId: null });

    const patched = await call('PATCH', `/api/people/${id}`, { notesMd: 'likes tea', archived: true });
    expect(patched.body).toMatchObject({ notesMd: 'likes tea' });
    expect(patched.body.archivedAt).not.toBeNull();
    expect((await call('GET', '/api/people')).body.people).toHaveLength(0);
    expect((await call('GET', '/api/people?includeArchived=1')).body.people).toHaveLength(1);
  });

  it('404s and validation', async () => {
    expect((await call('GET', '/api/people/999')).status).toBe(404);
    expect((await call('PATCH', '/api/people/999', { name: 'x' })).status).toBe(404);
    expect((await call('GET', '/api/people/abc')).status).toBe(400);
    expect((await call('POST', '/api/people', {})).status).toBe(400);
    expect((await call('POST', '/api/people', { name: 'A', extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/people', { name: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('POST', '/api/people', { name: '   ' })).status).toBe(400);
    expect((await call('POST', '/api/people', { name: 5 })).status).toBe(400);
    expect((await call('PATCH', '/api/people/1', {})).status).toBe(400);
    expect((await call('GET', '/api/people?includeArchived=yes')).status).toBe(400);
    expect((await call('GET', '/api/people?foo=1')).status).toBe(400);
    const bad = await call('POST', '/api/people', { name: 'A', extra: 1 });
    expect(bad.body.error.code).toBe('validation_error');
  });
});

describe('notes routes', () => {
  it('CRUD with soft delete', async () => {
    const p = await mkPerson();
    const n = await call('POST', '/api/notes', { bodyMd: 'Hello\nworld', personId: p.id });
    expect(n.status).toBe(201);
    expect(n.body).toMatchObject({ title: 'Hello', personId: p.id });
    expect((await call('GET', `/api/notes?personId=${p.id}`)).body.notes).toHaveLength(1);
    expect((await call('GET', `/api/notes/${n.body.id}`)).status).toBe(200);
    const up = await call('PATCH', `/api/notes/${n.body.id}`, { bodyMd: 'changed', personId: null });
    expect(up.body).toMatchObject({ bodyMd: 'changed', personId: null });
    expect((await call('DELETE', `/api/notes/${n.body.id}`)).status).toBe(204);
    expect((await call('GET', `/api/notes/${n.body.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/notes/${n.body.id}`)).status).toBe(404);
    expect((await call('GET', '/api/notes')).body.notes).toEqual([]);
  });

  it('rejects bad input', async () => {
    expect((await call('POST', '/api/notes', { title: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/notes', { bodyMd: 'x', nope: 1 })).status).toBe(400);
    expect((await call('POST', '/api/notes', { bodyMd: 'x'.repeat(200_001) })).status).toBe(400);
    expect((await call('POST', '/api/notes', { bodyMd: 'x', personId: '1' })).status).toBe(400);
    expect((await call('POST', '/api/notes', { bodyMd: 'x', personId: 999 })).status).toBe(400);
    expect((await call('GET', '/api/notes?personId=1;DROP')).status).toBe(400);
    expect((await call('PATCH', '/api/notes/999', { bodyMd: 'x' })).status).toBe(404);
    expect((await call('GET', '/api/notes/999')).status).toBe(404);
  });
});

describe('actions routes', () => {
  it('create, toggle done, filter, delete', async () => {
    const a = await call('POST', '/api/actions', { text: 'call bank' });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ owner: 'me', status: 'open', doneAt: null });
    const done = await call('PATCH', `/api/actions/${a.body.id}`, { status: 'done' });
    expect(done.body.doneAt).toBe(deps.now().toISOString());
    expect((await call('GET', '/api/actions')).body.actions).toHaveLength(0);
    expect((await call('GET', '/api/actions?status=done')).body.actions).toHaveLength(1);
    expect((await call('GET', '/api/actions?status=all&owner=them')).body.actions).toHaveLength(0);
    expect((await call('PATCH', `/api/actions/${a.body.id}`, { status: 'open' })).body.doneAt).toBeNull();
    expect((await call('DELETE', `/api/actions/${a.body.id}`)).status).toBe(204);
    expect((await call('GET', '/api/actions?status=all')).body.actions).toEqual([]);
    expect((await call('DELETE', `/api/actions/${a.body.id}`)).status).toBe(404);
  });

  it('validates input and references', async () => {
    expect((await call('POST', '/api/actions', { text: '' })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'x', owner: 'you' })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'x', extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'x'.repeat(10_001) })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'x', personId: 999 })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'x', meetingId: 999 })).status).toBe(400);
    expect((await call('GET', '/api/actions?status=weird')).status).toBe(400);
    expect((await call('PATCH', '/api/actions/999', { text: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/api/actions/1', { meetingId: 1 })).status).toBe(400);
  });
});

describe('search route', () => {
  it('searches via POST body and validates', async () => {
    await call('POST', '/api/notes', { bodyMd: 'quarterly budget' });
    const r = await call('POST', '/api/search', { q: 'budget' });
    expect(r.status).toBe(200);
    expect(r.body.results).toMatchObject([{ kind: 'note', title: 'quarterly budget' }]);
    expect((await call('POST', '/api/search', { q: 'b' })).status).toBe(400);
    expect((await call('POST', '/api/search', { q: ' b ' })).status).toBe(400);
    expect((await call('POST', '/api/search', {})).status).toBe(400);
    expect((await call('POST', '/api/search', { q: 'ab', limit: 51 })).status).toBe(400);
    expect((await call('POST', '/api/search', { q: 'ab', extra: true })).status).toBe(400);
    expect((await call('GET', '/api/search?q=budget')).status).toBe(404);
  });

  it('is injection-safe and wildcard-literal', async () => {
    await call('POST', '/api/notes', { bodyMd: 'plain text' });
    expect((await call('POST', '/api/search', { q: "'; DROP TABLE notes;--" })).body.results).toEqual([]);
    expect((await call('POST', '/api/search', { q: '%%' })).body.results).toEqual([]);
    expect((await call('GET', '/api/notes')).body.notes).toHaveLength(1);
  });
});

describe('1-1 loop over HTTP', () => {
  it('agenda -> meeting -> resolve -> follow-ups -> notes -> end -> next meeting', async () => {
    const p = await mkPerson();
    const items = [];
    for (const text of ['one', 'two', 'three']) {
      const r = await call('POST', `/api/people/${p.id}/agenda`, { text });
      expect(r.status).toBe(201);
      items.push(r.body);
    }
    const m1 = await call('POST', `/api/people/${p.id}/meetings`);
    expect(m1.status).toBe(201);
    expect(m1.body.openAgenda).toHaveLength(3);
    const mid = m1.body.meeting.id;

    const resumed = await call('POST', `/api/people/${p.id}/meetings`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.meeting.id).toBe(mid);

    const checked = await call('PATCH', `/api/agenda/${items[0].id}`, { status: 'done', meetingId: mid });
    expect(checked.body).toMatchObject({ status: 'done', resolvedMeetingId: mid });
    await call('POST', '/api/actions', { text: 'mine', owner: 'me', personId: p.id, meetingId: mid });
    await call('POST', '/api/actions', { text: 'theirs', owner: 'them', personId: p.id, meetingId: mid });
    expect((await call('PATCH', `/api/meetings/${mid}`, { notesMd: 'we talked' })).body.notesMd).toBe('we talked');

    const live = await call('GET', `/api/meetings/${mid}`);
    expect(live.body.openAgenda).toHaveLength(2);
    expect(live.body.resolvedHere).toHaveLength(1);
    expect(live.body.actionsHere).toHaveLength(2);

    const end1 = await call('POST', `/api/meetings/${mid}/end`);
    const end2 = await call('POST', `/api/meetings/${mid}/end`);
    expect(end1.status).toBe(200);
    expect(end1.body.endedAt).not.toBeNull();
    expect(end2.body).toEqual(end1.body);

    const m2 = await call('POST', `/api/people/${p.id}/meetings`);
    expect(m2.status).toBe(201);
    expect(m2.body.meeting.id).not.toBe(mid);
    expect(m2.body.openAgenda.map((i: any) => i.text)).toEqual(['two', 'three']);
    expect(m2.body.previous.meeting.notesMd).toBe('we talked');
    expect(m2.body.previous.resolved.map((i: any) => i.text)).toEqual(['one']);
    expect(m2.body.previous.actions.map((a: any) => a.text)).toEqual(['mine', 'theirs']);

    expect((await call('GET', `/api/people/${p.id}`)).body.activeMeetingId).toBe(m2.body.meeting.id);
  });

  it('agenda: reopen, drop, delete, 404s and validation', async () => {
    const p = await mkPerson();
    const i = (await call('POST', `/api/people/${p.id}/agenda`, { text: 'topic' })).body;
    const m = (await call('POST', `/api/people/${p.id}/meetings`)).body.meeting.id;
    expect((await call('PATCH', `/api/agenda/${i.id}`, { status: 'done', meetingId: 999 })).status).toBe(400);
    await call('PATCH', `/api/agenda/${i.id}`, { status: 'done', meetingId: m });
    expect((await call('PATCH', `/api/agenda/${i.id}`, { status: 'open' })).body).toMatchObject({ status: 'open', resolvedAt: null, resolvedMeetingId: null });
    expect((await call('PATCH', `/api/agenda/${i.id}`, { status: 'dropped' })).body.status).toBe('dropped');
    expect((await call('DELETE', `/api/agenda/${i.id}`)).status).toBe(204);
    expect((await call('GET', `/api/people/${p.id}`)).body.openAgenda).toEqual([]);
    expect((await call('PATCH', `/api/agenda/${i.id}`, { text: 'x' })).status).toBe(404);
    expect((await call('DELETE', `/api/agenda/${i.id}`)).status).toBe(404);
    expect((await call('POST', '/api/people/999/agenda', { text: 'x' })).status).toBe(404);
    expect((await call('POST', `/api/people/${p.id}/agenda`, { text: 'x', personId: 1 })).status).toBe(400);
    expect((await call('POST', `/api/people/${p.id}/agenda`, { text: '' })).status).toBe(400);
    expect((await call('PATCH', '/api/agenda/1', { status: 'bogus' })).status).toBe(400);
  });

  it('meeting 404s and validation', async () => {
    expect((await call('POST', '/api/people/999/meetings')).status).toBe(404);
    expect((await call('GET', '/api/meetings/999')).status).toBe(404);
    expect((await call('PATCH', '/api/meetings/999', { notesMd: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/meetings/999/end')).status).toBe(404);
    expect((await call('PATCH', '/api/meetings/1', {})).status).toBe(400);
    expect((await call('PATCH', '/api/meetings/1', { notesMd: 'x', more: 1 })).status).toBe(400);
    expect((await call('PATCH', '/api/meetings/1', { notesMd: 'x'.repeat(200_001) })).status).toBe(400);
  });
});

describe('same-owner checks', () => {
  async function setup() {
    const anna = await mkPerson('Anna');
    const bob = await mkPerson('Bob');
    const mAnna = (await call('POST', `/api/people/${anna.id}/meetings`)).body.meeting.id;
    const mBob = (await call('POST', `/api/people/${bob.id}/meetings`)).body.meeting.id;
    return { anna, bob, mAnna, mBob };
  }

  it('agenda item can only be resolved in a meeting with its own person', async () => {
    const { anna, mAnna, mBob } = await setup();
    const item = (await call('POST', `/api/people/${anna.id}/agenda`, { text: 'topic' })).body;
    const bad = await call('PATCH', `/api/agenda/${item.id}`, { status: 'done', meetingId: mBob });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_meeting');
    expect((await call('GET', `/api/meetings/${mBob}`)).body.resolvedHere).toEqual([]);
    expect((await call('PATCH', `/api/agenda/${item.id}`, { status: 'done', meetingId: mAnna })).status).toBe(200);
  });

  it('action create defaults personId from the meeting and rejects a mismatch', async () => {
    const { anna, bob, mAnna } = await setup();
    const a = await call('POST', '/api/actions', { text: 'follow up', meetingId: mAnna });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ personId: anna.id, meetingId: mAnna });
    const explicit = await call('POST', '/api/actions', { text: 'x', meetingId: mAnna, personId: anna.id });
    expect(explicit.status).toBe(201);
    const bad = await call('POST', '/api/actions', { text: 'x', meetingId: mAnna, personId: bob.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_meeting');
    expect((await call('GET', `/api/meetings/${mAnna}`)).body.actionsHere).toHaveLength(2);
  });

  it('action patch cannot move a meeting-linked action to another person', async () => {
    const { anna, bob, mAnna } = await setup();
    const a = (await call('POST', '/api/actions', { text: 'f', meetingId: mAnna })).body;
    expect((await call('PATCH', `/api/actions/${a.id}`, { personId: bob.id })).status).toBe(400);
    expect((await call('PATCH', `/api/actions/${a.id}`, { personId: null })).status).toBe(400);
    expect((await call('PATCH', `/api/actions/${a.id}`, { personId: anna.id, text: 'g' })).body.text).toBe('g');
    // an action with no meeting may still be reassigned
    const free = (await call('POST', '/api/actions', { text: 'free', personId: anna.id })).body;
    expect((await call('PATCH', `/api/actions/${free.id}`, { personId: bob.id })).body.personId).toBe(bob.id);
  });
});

describe('meeting detail hides soft-deleted items', () => {
  it('deleted agenda items and actions disappear from GET /meetings/:id', async () => {
    const p = await mkPerson();
    const open = (await call('POST', `/api/people/${p.id}/agenda`, { text: 'open item' })).body;
    const resolved = (await call('POST', `/api/people/${p.id}/agenda`, { text: 'resolved item' })).body;
    const m = (await call('POST', `/api/people/${p.id}/meetings`)).body.meeting.id;
    await call('PATCH', `/api/agenda/${resolved.id}`, { status: 'done', meetingId: m });
    const here = (await call('POST', '/api/actions', { text: 'here', meetingId: m })).body;
    const other = (await call('POST', '/api/actions', { text: 'other', personId: p.id })).body;
    const before = (await call('GET', `/api/meetings/${m}`)).body;
    expect([before.openAgenda.length, before.resolvedHere.length, before.actionsHere.length, before.otherOpenActions.length]).toEqual([1, 1, 1, 1]);
    for (const url of [`/api/agenda/${open.id}`, `/api/agenda/${resolved.id}`, `/api/actions/${here.id}`, `/api/actions/${other.id}`]) {
      expect((await call('DELETE', url)).status).toBe(204);
    }
    const after = (await call('GET', `/api/meetings/${m}`)).body;
    expect([after.openAgenda, after.resolvedHere, after.actionsHere, after.otherOpenActions]).toEqual([[], [], [], []]);
  });
});

describe('bounded lists and previews', () => {
  it('notes list returns previews, supports limit and before, caps limit', async () => {
    const body = 'y'.repeat(1000);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await call('POST', '/api/notes', { bodyMd: `${i}${body}` })).body.id);
    const page1 = await call('GET', '/api/notes?limit=2');
    expect(page1.body.notes.map((n: any) => n.id)).toEqual([ids[4], ids[3]]);
    expect(page1.body.notes[0].preview).toHaveLength(280);
    expect(page1.body.notes[0]).not.toHaveProperty('bodyMd');
    const page2 = await call('GET', `/api/notes?limit=2&before=${ids[3]}`);
    expect(page2.body.notes.map((n: any) => n.id)).toEqual([ids[2], ids[1]]);
    expect((await call('GET', `/api/notes/${ids[4]}`)).body.bodyMd).toHaveLength(1001);
    expect((await call('GET', '/api/notes?limit=201')).status).toBe(400);
    expect((await call('GET', '/api/notes?limit=0')).status).toBe(400);
    expect((await call('GET', '/api/notes?limit=200')).status).toBe(200);
    expect((await call('GET', '/api/notes?before=x')).status).toBe(400);
  });

  it('actions list supports limit and before', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await call('POST', '/api/actions', { text: `a${i}` })).body.id);
    expect((await call('GET', '/api/actions?limit=2')).body.actions.map((a: any) => a.id)).toEqual([ids[3], ids[2]]);
    expect((await call('GET', `/api/actions?limit=5&before=${ids[2]}`)).body.actions.map((a: any) => a.id)).toEqual([ids[1], ids[0]]);
    expect((await call('GET', '/api/actions?limit=201')).status).toBe(400);
  });

  it('person detail has note previews and meeting headers (latest 50), active one still reported', async () => {
    const p = await mkPerson();
    await call('POST', '/api/notes', { bodyMd: 'z'.repeat(500), personId: p.id });
    const ids: number[] = [];
    for (let i = 0; i < 52; i++) {
      const m = (await call('POST', `/api/people/${p.id}/meetings`)).body.meeting.id;
      ids.push(m);
      await call('PATCH', `/api/meetings/${m}`, { notesMd: `${i}`.padEnd(400, 'n') });
      if (i < 51) await call('POST', `/api/meetings/${m}/end`);
    }
    const d = (await call('GET', `/api/people/${p.id}`)).body;
    expect(d.notes[0].preview).toHaveLength(280);
    expect(d.notes[0]).not.toHaveProperty('bodyMd');
    expect(d.meetings).toHaveLength(50);
    expect(d.meetings[0]).not.toHaveProperty('notesMd');
    expect(d.meetings[0].preview).toHaveLength(280);
    expect(d.meetings[0].endedAt).toBeNull();
    expect(d.activeMeetingId).toBe(ids[51]);

    // page back through history
    const page = await call('GET', `/api/people/${p.id}/meetings?before=${d.meetings[49].id}&limit=10`);
    expect(page.status).toBe(200);
    expect(page.body.meetings.map((m: any) => m.id)).toEqual([ids[1], ids[0]]);
    expect((await call('GET', `/api/people/${p.id}/meetings?limit=3`)).body.meetings).toHaveLength(3);
    expect((await call('GET', `/api/people/${p.id}/meetings?limit=201`)).status).toBe(400);
    expect((await call('GET', `/api/people/${p.id}/meetings?x=1`)).status).toBe(400);
    expect((await call('GET', '/api/people/999/meetings')).status).toBe(404);
    // full notes stay on the detail route
    expect((await call('GET', `/api/meetings/${ids[0]}`)).body.meeting.notesMd).toHaveLength(400);
  });

  it('person detail caps notes at the latest 50', async () => {
    const p = await mkPerson();
    for (let i = 0; i < 51; i++) await call('POST', '/api/notes', { bodyMd: `n${i}`, personId: p.id });
    const d = (await call('GET', `/api/people/${p.id}`)).body;
    expect(d.notes).toHaveLength(50);
    expect(d.notes[0].title).toBe('n50');
  });
});

describe('empty-schema routes', () => {
  it('reject unknown query strings and bodies on bodyless POSTs', async () => {
    const p = await mkPerson();
    expect((await call('GET', `/api/people/${p.id}?x=1`)).status).toBe(400);
    expect((await call('GET', '/api/meetings/1?x=1')).status).toBe(400);
    expect((await call('POST', `/api/people/${p.id}/meetings`, { extra: 1 })).status).toBe(400);
    expect((await call('POST', `/api/people/${p.id}/meetings`, [])).status).toBe(400);
    expect((await call('POST', `/api/people/${p.id}/meetings?x=1`)).status).toBe(400);
    const m = (await call('POST', `/api/people/${p.id}/meetings`)).body.meeting.id;
    expect((await call('POST', `/api/meetings/${m}/end`, { extra: 1 })).status).toBe(400);
    expect((await call('POST', `/api/meetings/${m}/end`, {})).status).toBe(200);
    expect((await call('POST', `/api/meetings/${m}/end`)).status).toBe(200);
    expect((await call('DELETE', '/api/notes/1?x=1')).status).toBe(400);
    expect((await call('POST', '/api/search?q=ab', { q: 'ab' })).status).toBe(400);
  });
});
