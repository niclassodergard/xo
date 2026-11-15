import { beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { makeTestDb } from '../../../test/helpers.ts';
import { assertLiveProject, createAction, getAction, listActions, ProjectNotFoundError, updateAction } from './actions.ts';
import { emptyDraft, getCaptureRecord, insertCapture, scrubProjectFromCaptures } from './captures.ts';
import type { StoredDraft } from './captures.ts';
import { createNote, getNote, listNoteSummaries, updateNote } from './notes.ts';
import { createPerson } from './people.ts';
import {
  createProject, getProject, getProjectDetail, linkPerson, listProjects, listProjectsForMatching, softDeleteProject,
  unlinkPerson, updateProject,
} from './projects.ts';

const T0 = new Date('2026-01-01T10:00:00.000Z');
const T1 = new Date('2026-01-02T10:00:00.000Z');
let db: DatabaseSync;
beforeEach(() => { db = makeTestDb(); });

describe('projects repo', () => {
  it('creates with defaults, normalizes aliases, updates and returns null for unknown ids', () => {
    const p = createProject(db, { title: ' Apollo ', aliases: [' Moon ', 'moon', ''] }, T0);
    expect(p).toMatchObject({ title: 'Apollo', aliases: ['Moon'], status: 'active', descriptionMd: '', createdAt: T0.toISOString() });
    const u = updateProject(db, p.id, { status: 'on_hold', descriptionMd: 'plan' }, T1)!;
    expect(u).toMatchObject({ title: 'Apollo', status: 'on_hold', descriptionMd: 'plan', updatedAt: T1.toISOString() });
    expect(updateProject(db, 99, { title: 'x' }, T0)).toBeNull();
    expect(getProject(db, 99)).toBeNull();
  });

  it('lists active, on hold, done, then by Swedish title, with open action counts', () => {
    const mk = (title: string, status: 'active' | 'on_hold' | 'done') => createProject(db, { title, status }, T0);
    mk('Zeta', 'active'); mk('Östra', 'active'); mk('Åre-resa', 'active'); mk('Beta', 'done'); mk('Alfa', 'on_hold');
    const apollo = mk('Apollo', 'active');
    createAction(db, { text: 'a', projectId: apollo.id }, T0);
    const done = createAction(db, { text: 'b', projectId: apollo.id }, T0);
    updateAction(db, done.id, { status: 'done' }, T1);
    const all = listProjects(db);
    expect(all.map((p) => p.title)).toEqual(['Apollo', 'Zeta', 'Åre-resa', 'Östra', 'Alfa', 'Beta']);
    expect(all[0]).toMatchObject({ title: 'Apollo', openActions: 1 });
    expect(listProjects(db, { status: 'done' }).map((p) => p.title)).toEqual(['Beta']);
    expect(listProjects(db, { status: 'all' })).toHaveLength(6);
  });

  it('round-trips Swedish titles and stores SQL metacharacters literally', () => {
    const p = createProject(db, { title: 'Åre-resa', aliases: ['Fjällen'] }, T0);
    expect(getProject(db, p.id)).toMatchObject({ title: 'Åre-resa', aliases: ['Fjällen'] });
    const evil = createProject(db, { title: "x'); DROP TABLE projects; --", descriptionMd: "'; DROP TABLE notes; --" }, T0);
    expect(getProject(db, evil.id)!.title).toBe("x'); DROP TABLE projects; --");
    expect(listProjects(db)).toHaveLength(2);
  });

  it('listProjectsForMatching leaves out done and deleted projects', () => {
    createProject(db, { title: 'Live', aliases: ['L'] }, T0);
    createProject(db, { title: 'Finished', status: 'done' }, T0);
    const gone = createProject(db, { title: 'Gone' }, T0);
    softDeleteProject(db, gone.id, T1);
    expect(listProjectsForMatching(db)).toEqual([{ id: 1, title: 'Live', aliases: ['L'] }]);
  });

  it('links and unlinks people idempotently; missing project or person returns false', () => {
    const p = createProject(db, { title: 'P' }, T0);
    const a = createPerson(db, { name: 'Anna' }, T0);
    expect(linkPerson(db, p.id, a.id, T0)).toBe(true);
    expect(linkPerson(db, p.id, a.id, T1)).toBe(true);
    expect(getProjectDetail(db, p.id)!.people.map((x) => x.name)).toEqual(['Anna']);
    expect(unlinkPerson(db, p.id, a.id)).toBe(true);
    expect(unlinkPerson(db, p.id, a.id)).toBe(true);
    expect(getProjectDetail(db, p.id)!.people).toEqual([]);
    expect(linkPerson(db, p.id, 99, T0)).toBe(false);
    expect(linkPerson(db, 99, a.id, T0)).toBe(false);
    expect(unlinkPerson(db, p.id, 99)).toBe(false);
  });

  it('detail: open actions, latest 50 done actions, latest 50 notes; no deleted rows', () => {
    const p = createProject(db, { title: 'P' }, T0);
    createAction(db, { text: 'open', projectId: p.id }, T0);
    for (let i = 0; i < 52; i++) {
      const a = createAction(db, { text: `d${i}`, projectId: p.id }, T0);
      updateAction(db, a.id, { status: 'done' }, new Date(T0.getTime() + i * 1000));
    }
    for (let i = 0; i < 51; i++) createNote(db, { bodyMd: `n${i}`, projectId: p.id }, T0);
    createNote(db, { bodyMd: 'other' }, T0);
    const d = getProjectDetail(db, p.id)!;
    expect(d.openActions.map((a) => a.text)).toEqual(['open']);
    expect(d.doneActions).toHaveLength(50);
    expect(d.doneActions[0]!.text).toBe('d51');
    expect(d.notes).toHaveLength(50);
    expect(d.notes[0]!.title).toBe('n50');
    expect(getProjectDetail(db, 99)).toBeNull();
  });
});

describe('project_id on actions and notes', () => {
  it('create, move, clear and filter actions', () => {
    const p1 = createProject(db, { title: 'One' }, T0);
    const p2 = createProject(db, { title: 'Two' }, T0);
    const a = createAction(db, { text: 'x', projectId: p1.id }, T0);
    createAction(db, { text: 'loose' }, T0);
    expect(a.projectId).toBe(p1.id);
    expect(listActions(db, { projectId: p1.id }).map((x) => x.text)).toEqual(['x']);
    expect(listActions(db, { projectId: 'none' }).map((x) => x.text)).toEqual(['loose']);
    expect(updateAction(db, a.id, { projectId: p2.id }, T1)!.projectId).toBe(p2.id);
    expect(updateAction(db, a.id, { text: 'y' }, T1)!.projectId).toBe(p2.id); // untouched when absent
    expect(updateAction(db, a.id, { projectId: null }, T1)!.projectId).toBeNull();
  });

  it('create, move, clear and filter notes', () => {
    const p1 = createProject(db, { title: 'One' }, T0);
    const p2 = createProject(db, { title: 'Two' }, T0);
    const n = createNote(db, { bodyMd: 'hello', projectId: p1.id }, T0);
    createNote(db, { bodyMd: 'loose' }, T0);
    expect(listNoteSummaries(db, { projectId: p1.id }).map((x) => x.title)).toEqual(['hello']);
    expect(listNoteSummaries(db, { projectId: p1.id })[0]!.projectId).toBe(p1.id);
    expect(listNoteSummaries(db, { projectId: 'none' }).map((x) => x.title)).toEqual(['loose']);
    expect(updateNote(db, n.id, { projectId: p2.id }, T1)!.projectId).toBe(p2.id);
    expect(updateNote(db, n.id, { bodyMd: 'edit' }, T1)!.projectId).toBe(p2.id);
    expect(updateNote(db, n.id, { projectId: null }, T1)!.projectId).toBeNull();
  });

  it('rejects a missing or deleted project on create and on a changed link', () => {
    const p = createProject(db, { title: 'P' }, T0);
    const a = createAction(db, { text: 'x' }, T0);
    const n = createNote(db, { bodyMd: 'x' }, T0);
    expect(() => createAction(db, { text: 'x', projectId: 999 }, T0)).toThrow(ProjectNotFoundError);
    expect(() => createNote(db, { bodyMd: 'x', projectId: 999 }, T0)).toThrow(ProjectNotFoundError);
    expect(() => updateAction(db, a.id, { projectId: 999 }, T1)).toThrow(ProjectNotFoundError);
    expect(() => updateNote(db, n.id, { projectId: 999 }, T1)).toThrow(ProjectNotFoundError);
    softDeleteProject(db, p.id, T1);
    expect(() => createAction(db, { text: 'x', projectId: p.id }, T0)).toThrow(ProjectNotFoundError);
    expect(() => updateNote(db, n.id, { projectId: p.id }, T1)).toThrow(ProjectNotFoundError);
    expect(() => assertLiveProject(db, null)).not.toThrow();
    // nothing was written by the failed calls
    expect(listActions(db, { status: 'all' })).toHaveLength(1);
  });
});

describe('softDeleteProject', () => {
  it('detaches actions and notes, removes links, pins and recents, and hides the project', () => {
    const p = createProject(db, { title: 'Apollo' }, T0);
    const other = createProject(db, { title: 'Other' }, T0);
    const person = createPerson(db, { name: 'Anna' }, T0);
    linkPerson(db, p.id, person.id, T0);
    linkPerson(db, other.id, person.id, T0);
    const a = createAction(db, { text: 'act', projectId: p.id }, T0);
    const n = createNote(db, { bodyMd: 'note', projectId: p.id }, T0);
    const keep = createAction(db, { text: 'keep', projectId: other.id }, T0);
    for (const [k, id] of [['project', p.id], ['project', other.id]] as const) {
      db.prepare('INSERT INTO pins (kind, item_id, created_at) VALUES (?, ?, ?)').run(k, id, T0.toISOString());
      db.prepare('INSERT INTO recents (kind, item_id, opened_at) VALUES (?, ?, ?)').run(k, id, T0.toISOString());
    }
    db.prepare("INSERT INTO pins (kind, item_id, created_at) VALUES ('person', ?, ?)").run(p.id, T0.toISOString()); // same id, other kind

    expect(softDeleteProject(db, p.id, T1)).toBe(true);
    expect(softDeleteProject(db, p.id, T1)).toBe(false);
    expect(getProject(db, p.id)).toBeNull();
    expect(getProjectDetail(db, p.id)).toBeNull();
    expect(listProjects(db).map((x) => x.title)).toEqual(['Other']);
    expect(getAction(db, a.id)!.projectId).toBeNull();
    expect(getNote(db, n.id)!.projectId).toBeNull();
    expect(getAction(db, keep.id)!.projectId).toBe(other.id);
    const count = (t: string, where: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`).get() as { n: number }).n;
    expect(count('project_people', `project_id = ${p.id}`)).toBe(0);
    expect(count('project_people', `project_id = ${other.id}`)).toBe(1);
    expect(count('pins', `kind = 'project' AND item_id = ${p.id}`)).toBe(0);
    expect(count('pins', `kind = 'project' AND item_id = ${other.id}`)).toBe(1);
    expect(count('pins', `kind = 'person'`)).toBe(1);
    expect(count('recents', `kind = 'project' AND item_id = ${p.id}`)).toBe(0);
    expect(count('recents', `kind = 'project' AND item_id = ${other.id}`)).toBe(1);
    expect(linkPerson(db, p.id, person.id, T1)).toBe(false);
  });

  it('is atomic: a failure while scrubbing rolls everything back', () => {
    const p = createProject(db, { title: 'Apollo' }, T0);
    const a = createAction(db, { text: 'act', projectId: p.id }, T0);
    db.exec('DROP TABLE recents');
    expect(() => softDeleteProject(db, p.id, T1)).toThrow();
    expect(getProject(db, p.id)).not.toBeNull();
    expect(getAction(db, a.id)!.projectId).toBe(p.id);
  });
});

function pending(over: Partial<StoredDraft>, question: unknown, filed: unknown[] = []) {
  return insertCapture(
    db,
    {
      text: 'todo #apollo', source: 'text', status: 'pending', draft: { ...emptyDraft(), kind: 'action', text: 'x', ...over },
      question: question as never, filed: filed as never, summary: '', classifiedBy: null,
    },
    T0,
  );
}

describe('project scrub in captures (amended rules)', () => {
  it('an unknown_project question and its name survive creating and deleting a project of that name', () => {
    const c = pending({ projectPending: true, projectName: 'Zeta', projectCreate: 'Zeta' }, { type: 'unknown_project', name: 'Zeta', options: [{ key: 'c', label: 'Create' }] });
    const z = createProject(db, { title: 'Zeta' }, T0);
    softDeleteProject(db, z.id, T1);
    const r = getCaptureRecord(db, c.id)!;
    expect(r.question).toMatchObject({ type: 'unknown_project', name: 'Zeta' });
    expect(r.draft).toMatchObject({ projectName: 'Zeta', projectPending: true, projectCreate: 'Zeta' });
  });

  it('a draft linked to project B is unchanged when A (whose alias equals its name) is deleted', () => {
    const a = createProject(db, { title: 'Alpha', aliases: ['Moon'] }, T0);
    const b = createProject(db, { title: 'Beta' }, T0);
    const c = pending({ projectId: b.id, projectName: 'Moon' }, { type: 'kind', options: [] });
    softDeleteProject(db, a.id, T1);
    const r = getCaptureRecord(db, c.id)!;
    expect(r.draft).toMatchObject({ projectId: b.id, projectName: 'Moon' });
    expect(r.question).toMatchObject({ type: 'kind' });
  });

  it('removing the last candidate clears name, pending and suggested; projectCreate stays', () => {
    const a = createProject(db, { title: 'Alpha' }, T0);
    const c = pending({ projectPending: true, projectSuggested: true, projectCandidates: [a.id], projectName: 'alp', projectCreate: 'Mine' },
      { type: 'ambiguous_project', name: 'alp', candidates: [{ key: '1', projectId: a.id, title: 'Alpha' }], options: [] });
    softDeleteProject(db, a.id, T1);
    const r = getCaptureRecord(db, c.id)!;
    expect(r.question).toBeNull();
    expect(r.draft).toMatchObject({ projectName: null, projectPending: false, projectSuggested: false, projectCandidates: [], projectCreate: 'Mine' });
  });

  it('removing one of two candidates keeps the other, the name and the pending state', () => {
    const a = createProject(db, { title: 'Alpha' }, T0);
    const b = createProject(db, { title: 'Alpine' }, T0);
    const c = pending({ projectPending: true, projectCandidates: [a.id, b.id], projectName: 'alp' },
      { type: 'ambiguous_project', name: 'alp', candidates: [{ key: '1', projectId: a.id, title: 'Alpha' }, { key: '2', projectId: b.id, title: 'Alpine' }], options: [] });
    softDeleteProject(db, a.id, T1);
    const r = getCaptureRecord(db, c.id)!;
    expect(r.question).toBeNull();
    expect(r.draft).toMatchObject({ projectCandidates: [b.id], projectName: 'alp', projectPending: true });
    expect(JSON.stringify(db.prepare('SELECT question FROM captures').all())).not.toContain('Alpha');
  });
});

describe('project scrub in captures', () => {
  it('parses the new question types and rejects malformed ones', () => {
    const ok1 = pending({}, { type: 'unknown_project', name: 'Zeta', options: [{ key: 'c', label: 'Create' }] });
    const ok2 = pending({}, { type: 'ambiguous_project', name: 'Ap', candidates: [{ key: '1', projectId: 4, title: 'Apollo' }], options: [] });
    expect(getCaptureRecord(db, ok1.id)!.question).toMatchObject({ type: 'unknown_project', name: 'Zeta' });
    expect(getCaptureRecord(db, ok2.id)!.question).toMatchObject({ type: 'ambiguous_project', candidates: [{ projectId: 4, title: 'Apollo' }] });
    const bad = pending({}, { type: 'ambiguous_project', name: 'Ap', candidates: [{ key: '1', projectId: 'x', title: 'Apollo' }], options: [] });
    expect(getCaptureRecord(db, bad.id)!.question).toBeNull();
  });

  it('old drafts without the new fields get safe defaults', () => {
    db.prepare("INSERT INTO captures (text, source, status, draft, filed, summary, created_at, updated_at) VALUES ('t', 'text', 'pending', ?, '[]', '', ?, ?)")
      .run(JSON.stringify({ kind: 'note', text: 't', personId: 2, personName: 'A', owner: 'me', personPending: false, candidates: [], suggested: false }), T0.toISOString(), T0.toISOString());
    expect(getCaptureRecord(db, 1)!.draft).toMatchObject({
      personId: 2, projectId: null, projectName: null, projectPending: false, projectCandidates: [],
      projectSuggested: false, personCreate: null, projectCreate: null,
    });
  });

  it('delete makes a pending project question re-derivable and filed refs lose the project', () => {
    const p = createProject(db, { title: 'Apollo', aliases: ['Moon'] }, T0);
    const other = createProject(db, { title: 'Apollo Two' }, T0);
    const amb = pending(
      { projectPending: true, projectCandidates: [p.id, other.id], projectName: 'Apollo', projectSuggested: false },
      { type: 'ambiguous_project', name: 'Apollo', candidates: [{ key: '1', projectId: p.id, title: 'Apollo' }, { key: '2', projectId: other.id, title: 'Apollo Two' }], options: [] },
    );
    const linked = pending({ projectId: p.id, projectName: 'Apollo' }, null);
    const filed = insertCapture(db, {
      text: 'x', source: 'text', status: 'filed', draft: { ...emptyDraft(), projectId: p.id }, question: null,
      filed: [{ kind: 'action', id: 1 }, { kind: 'project', id: p.id }, { kind: 'project', id: other.id }], summary: 'Action: x', classifiedBy: 'prefix',
    }, T0);
    const unrelated = pending({ projectId: other.id }, { type: 'kind', options: [{ key: 'n', label: 'Note' }] });

    softDeleteProject(db, p.id, T1);

    const a = getCaptureRecord(db, amb.id)!;
    expect(a.question).toBeNull();
    expect(a.draft.projectCandidates).toEqual([other.id]);
    expect(a.draft.projectName).toBe('Apollo'); // candidates remain, so the name stays
    expect(a.draft.projectPending).toBe(true);
    const l = getCaptureRecord(db, linked.id)!;
    expect(l.draft).toMatchObject({ projectId: null, projectName: null });
    const f = getCaptureRecord(db, filed.id)!;
    expect(f.filed).toEqual([{ kind: 'action', id: 1 }, { kind: 'project', id: other.id }]);
    expect(f.draft.projectId).toBeNull();
    const u = getCaptureRecord(db, unrelated.id)!;
    expect(u.draft.projectId).toBe(other.id);
    expect(u.question).toMatchObject({ type: 'kind' });
    // no raw capture column still names the deleted project's candidate title
    const dump = JSON.stringify(db.prepare('SELECT draft, question, filed FROM captures WHERE id IN (?, ?, ?)').all(amb.id, linked.id, filed.id));
    expect(dump).not.toContain('"title":"Apollo"');
  });

  it('a capture that only had the deleted project as candidate stops being pending', () => {
    const p = createProject(db, { title: 'Apollo' }, T0);
    const c = pending({ projectPending: true, projectCandidates: [p.id], projectSuggested: true },
      { type: 'ambiguous_project', name: 'apollo', candidates: [{ key: '1', projectId: p.id, title: 'Apollo' }], options: [] });
    expect(scrubProjectFromCaptures(db, p.id, T1)).toBe(1);
    const r = getCaptureRecord(db, c.id)!;
    expect(r.question).toBeNull();
    expect(r.draft).toMatchObject({ projectPending: false, projectSuggested: false, projectCandidates: [] });
  });

  it('survives damaged rows', () => {
    const p = createProject(db, { title: 'Apollo' }, T0);
    db.prepare("INSERT INTO captures (text, source, status, draft, question, filed, summary, created_at, updated_at) VALUES ('t', 'text', 'pending', 'not json', '{\"type\":\"ambiguous_project\"}', 'oops', '', ?, ?)")
      .run(T0.toISOString(), T0.toISOString());
    expect(() => softDeleteProject(db, p.id, T1)).not.toThrow();
    expect(getCaptureRecord(db, 1)!.question).toBeNull();
  });
});
