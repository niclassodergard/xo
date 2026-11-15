import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import actionsRoutes from './actions.ts';
import notesRoutes from './notes.ts';
import peopleRoutes from './people.ts';
import projectsRoutes from './projects.ts';

type Opts = { deps: AppDeps };
async function all(app: FastifyInstance, opts: Opts): Promise<void> {
  for (const r of [peopleRoutes, notesRoutes, actionsRoutes, projectsRoutes]) await app.register(r, { deps: opts.deps });
}

let app: FastifyInstance;
let deps: AppDeps;
beforeEach(async () => {
  deps = makeDeps();
  app = await makeRouteApp(all, deps);
});
afterEach(async () => { await app.close(); });

async function call(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
}
const mkProject = async (title = 'Apollo', extra: object = {}) => (await call('POST', '/api/projects', { title, ...extra })).body;

describe('projects routes', () => {
  it('create, list, get, patch, delete', async () => {
    const created = await call('POST', '/api/projects', { title: ' Apollo ', aliases: ['Moon'], descriptionMd: 'plan' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ title: 'Apollo', aliases: ['Moon'], status: 'active', descriptionMd: 'plan' });
    const id = created.body.id;

    expect((await call('GET', '/api/projects')).body.projects).toEqual([
      expect.objectContaining({ id, title: 'Apollo', openActions: 0 }),
    ]);
    expect((await call('GET', `/api/projects/${id}`)).body).toMatchObject({
      project: { id }, people: [], openActions: [], doneActions: [], notes: [],
    });
    const patched = await call('PATCH', `/api/projects/${id}`, { status: 'done', title: 'Apollo 2' });
    expect(patched.body).toMatchObject({ title: 'Apollo 2', status: 'done' });
    expect((await call('DELETE', `/api/projects/${id}`)).status).toBe(204);
    expect((await call('GET', `/api/projects/${id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${id}`)).status).toBe(404);
    expect((await call('PATCH', `/api/projects/${id}`, { title: 'x' })).status).toBe(404);
    expect((await call('GET', '/api/projects')).body.projects).toEqual([]);
  });

  it('filters the list by status', async () => {
    await mkProject('A'); await mkProject('B', { status: 'on_hold' }); await mkProject('C', { status: 'done' });
    const titles = async (q: string) => (await call('GET', `/api/projects${q}`)).body.projects.map((p: any) => p.title);
    expect(await titles('')).toEqual(['A', 'B', 'C']);
    expect(await titles('?status=all')).toEqual(['A', 'B', 'C']);
    expect(await titles('?status=on_hold')).toEqual(['B']);
    expect(await titles('?status=done')).toEqual(['C']);
    expect((await call('GET', '/api/projects?status=bogus')).status).toBe(400);
    expect((await call('GET', '/api/projects?x=1')).status).toBe(400);
  });

  it('validation: blank title, unknown fields, bad status, wrong types, 404s', async () => {
    expect((await call('POST', '/api/projects', {})).status).toBe(400);
    expect((await call('POST', '/api/projects', { title: '   ' })).status).toBe(400);
    expect((await call('POST', '/api/projects', { title: 'x'.repeat(201) })).status).toBe(400);
    expect((await call('POST', '/api/projects', { title: 'A', extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/projects', { title: 'A', status: 'archived' })).status).toBe(400);
    expect((await call('POST', '/api/projects', { title: 5 })).status).toBe(400);
    expect((await call('POST', '/api/projects?x=1', { title: 'A' })).status).toBe(400);
    const p = await mkProject();
    expect((await call('PATCH', `/api/projects/${p.id}`, {})).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${p.id}`, { title: '  ' })).status).toBe(400);
    expect((await call('PATCH', `/api/projects/${p.id}`, { id: 5 })).status).toBe(400);
    expect((await call('GET', '/api/projects/999')).status).toBe(404);
    expect((await call('GET', '/api/projects/abc')).status).toBe(400);
    expect((await call('GET', `/api/projects/${p.id}?x=1`)).status).toBe(400);
  });

  it('stores Swedish titles and SQL metacharacters literally', async () => {
    const a = await mkProject('Åre-resa');
    const b = await mkProject("'; DROP TABLE projects; --");
    expect((await call('GET', `/api/projects/${a.id}`)).body.project.title).toBe('Åre-resa');
    expect((await call('GET', `/api/projects/${b.id}`)).body.project.title).toBe("'; DROP TABLE projects; --");
    expect((await call('GET', '/api/projects')).body.projects).toHaveLength(2);
  });

  it('links and unlinks people idempotently, 404 when either is missing', async () => {
    const p = await mkProject();
    const person = (await call('POST', '/api/people', { name: 'Anna' })).body;
    expect((await call('PUT', `/api/projects/${p.id}/people/${person.id}`)).status).toBe(204);
    expect((await call('PUT', `/api/projects/${p.id}/people/${person.id}`)).status).toBe(204);
    expect((await call('GET', `/api/projects/${p.id}`)).body.people.map((x: any) => x.name)).toEqual(['Anna']);
    expect((await call('DELETE', `/api/projects/${p.id}/people/${person.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/projects/${p.id}/people/${person.id}`)).status).toBe(204);
    expect((await call('GET', `/api/projects/${p.id}`)).body.people).toEqual([]);
    expect((await call('PUT', `/api/projects/${p.id}/people/999`)).status).toBe(404);
    expect((await call('PUT', `/api/projects/999/people/${person.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${p.id}/people/999`)).status).toBe(404);
    expect((await call('PUT', `/api/projects/${p.id}/people/abc`)).status).toBe(400);
    expect((await call('PUT', `/api/projects/${p.id}/people/${person.id}`, { x: 1 })).status).toBe(400);
  });

  it('detail carries actions and notes, caps done actions and notes at 50', async () => {
    const p = await mkProject();
    await call('POST', '/api/actions', { text: 'open one', projectId: p.id });
    for (let i = 0; i < 51; i++) {
      const a = (await call('POST', '/api/actions', { text: `d${i}`, projectId: p.id })).body;
      await call('PATCH', `/api/actions/${a.id}`, { status: 'done' });
    }
    for (let i = 0; i < 51; i++) await call('POST', '/api/notes', { bodyMd: `n${i}`, projectId: p.id });
    const d = (await call('GET', `/api/projects/${p.id}`)).body;
    expect(d.openActions.map((a: any) => a.text)).toEqual(['open one']);
    expect(d.doneActions).toHaveLength(50);
    expect(d.notes).toHaveLength(50);
    expect(d.notes[0]).toMatchObject({ projectId: p.id, preview: 'n50' });
    expect((await call('GET', '/api/projects')).body.projects[0].openActions).toBe(1);
  });
});

describe('projectId on actions and notes (routes)', () => {
  it('actions: create, patch to another, patch to null, filter by id and none', async () => {
    const p1 = await mkProject('One');
    const p2 = await mkProject('Two');
    const a = await call('POST', '/api/actions', { text: 'x', projectId: p1.id });
    expect(a.status).toBe(201);
    expect(a.body.projectId).toBe(p1.id);
    await call('POST', '/api/actions', { text: 'loose' });
    const texts = async (q: string) => (await call('GET', `/api/actions${q}`)).body.actions.map((x: any) => x.text);
    expect(await texts(`?projectId=${p1.id}`)).toEqual(['x']);
    expect(await texts('?projectId=none')).toEqual(['loose']);
    expect((await call('PATCH', `/api/actions/${a.body.id}`, { projectId: p2.id })).body.projectId).toBe(p2.id);
    expect(await texts(`?projectId=${p1.id}`)).toEqual([]);
    expect((await call('PATCH', `/api/actions/${a.body.id}`, { projectId: null })).body.projectId).toBeNull();
    expect((await call('GET', '/api/actions?projectId=abc')).status).toBe(400);
    expect((await call('GET', '/api/actions?projectId=-1')).status).toBe(400);
  });

  it('actions: a missing or deleted project is a 400 validation_error and writes nothing', async () => {
    const p = await mkProject();
    const a = (await call('POST', '/api/actions', { text: 'x' })).body;
    const bad = await call('POST', '/api/actions', { text: 'y', projectId: 999 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation_error');
    expect((await call('PATCH', `/api/actions/${a.id}`, { projectId: 999 })).status).toBe(400);
    await call('DELETE', `/api/projects/${p.id}`);
    expect((await call('POST', '/api/actions', { text: 'y', projectId: p.id })).status).toBe(400);
    expect((await call('PATCH', `/api/actions/${a.id}`, { projectId: p.id })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'y', projectId: 0 })).status).toBe(400);
    expect((await call('POST', '/api/actions', { text: 'y', projectId: '1' })).status).toBe(400);
    expect((await call('GET', '/api/actions?status=all')).body.actions).toHaveLength(1);
  });

  it('notes: create, patch, summary and detail carry projectId, filter by id and none', async () => {
    const p1 = await mkProject('One');
    const p2 = await mkProject('Two');
    const n = await call('POST', '/api/notes', { bodyMd: 'hello', projectId: p1.id });
    expect(n.body.projectId).toBe(p1.id);
    await call('POST', '/api/notes', { bodyMd: 'loose' });
    const titles = async (q: string) => (await call('GET', `/api/notes${q}`)).body.notes.map((x: any) => x.title);
    expect(await titles(`?projectId=${p1.id}`)).toEqual(['hello']);
    expect(await titles('?projectId=none')).toEqual(['loose']);
    expect((await call('GET', '/api/notes')).body.notes.every((x: any) => 'projectId' in x)).toBe(true);
    expect((await call('PATCH', `/api/notes/${n.body.id}`, { projectId: p2.id })).body.projectId).toBe(p2.id);
    expect((await call('GET', `/api/notes/${n.body.id}`)).body.projectId).toBe(p2.id);
    expect((await call('PATCH', `/api/notes/${n.body.id}`, { projectId: null })).body.projectId).toBeNull();
  });

  it('notes: a missing or deleted project is rejected', async () => {
    const p = await mkProject();
    const n = (await call('POST', '/api/notes', { bodyMd: 'x' })).body;
    expect((await call('POST', '/api/notes', { bodyMd: 'y', projectId: 999 })).status).toBe(400);
    await call('DELETE', `/api/projects/${p.id}`);
    expect((await call('POST', '/api/notes', { bodyMd: 'y', projectId: p.id })).status).toBe(400);
    expect((await call('PATCH', `/api/notes/${n.id}`, { projectId: p.id })).status).toBe(400);
    expect((await call('GET', '/api/notes?projectId=x')).status).toBe(400);
  });

  it('deleting a project keeps its actions and notes without the project', async () => {
    const p = await mkProject();
    const a = (await call('POST', '/api/actions', { text: 'x', projectId: p.id })).body;
    const n = (await call('POST', '/api/notes', { bodyMd: 'x', projectId: p.id })).body;
    await call('DELETE', `/api/projects/${p.id}`);
    expect((await call('GET', '/api/actions')).body.actions).toEqual([expect.objectContaining({ id: a.id, projectId: null })]);
    expect((await call('GET', `/api/notes/${n.id}`)).body.projectId).toBeNull();
  });
});
