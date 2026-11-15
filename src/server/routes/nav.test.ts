import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import { createNote, softDeleteNote } from '../repos/notes.ts';
import { createPerson } from '../repos/people.ts';
import { createProject, softDeleteProject } from '../repos/projects.ts';
import navRoutes from './nav.ts';

let app: FastifyInstance;
let deps: AppDeps;
beforeEach(async () => {
  deps = makeDeps();
  app = await makeRouteApp(async (a, o) => { await a.register(navRoutes, { deps: o.deps }); }, deps);
});
afterEach(async () => { await app.close(); });

async function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
}
const now = (): Date => deps.now();

describe('nav routes', () => {
  it('GET /api/nav is empty at first', async () => {
    expect(await call('GET', '/api/nav')).toEqual({ status: 200, body: { pinned: [], recents: [] } });
  });

  it('pins and unpins idempotently', async () => {
    const p = createPerson(deps.db, { name: 'Anna' }, now());
    const proj = createProject(deps.db, { title: 'Apollo' }, now());
    expect((await call('PUT', `/api/nav/pins/person/${p.id}`)).status).toBe(204);
    expect((await call('PUT', `/api/nav/pins/person/${p.id}`)).status).toBe(204);
    expect((await call('PUT', `/api/nav/pins/project/${proj.id}`)).status).toBe(204);
    expect((await call('GET', '/api/nav')).body.pinned).toEqual([
      { kind: 'person', id: p.id, title: 'Anna', archived: false },
      { kind: 'project', id: proj.id, title: 'Apollo', archived: false },
    ]);
    expect((await call('DELETE', `/api/nav/pins/person/${p.id}`)).status).toBe(204);
    expect((await call('DELETE', `/api/nav/pins/person/${p.id}`)).status).toBe(204);
    expect((await call('GET', '/api/nav')).body.pinned).toHaveLength(1);
  });

  it('rejects a bad kind or id with 400', async () => {
    for (const url of ['/api/nav/pins/note/1', '/api/nav/pins/meeting/1', '/api/nav/pins/person/abc', '/api/nav/pins/person/-1', '/api/nav/pins/person/1.5']) {
      expect((await call('PUT', url)).status).toBe(400);
      expect((await call('DELETE', url)).status).toBe(400);
    }
    expect((await call('PUT', '/api/nav/pins/person/1', { x: 1 })).status).toBe(400);
  });

  it('404 for a missing or deleted item', async () => {
    const proj = createProject(deps.db, { title: 'Apollo' }, now());
    expect((await call('PUT', '/api/nav/pins/person/999')).status).toBe(404);
    softDeleteProject(deps.db, proj.id, now());
    const r = await call('PUT', `/api/nav/pins/project/${proj.id}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('not_found');
  });

  it('409 too_many on the 51st pin', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => createPerson(deps.db, { name: `P${i}` }, now()).id);
    for (const id of ids.slice(0, 50)) expect((await call('PUT', `/api/nav/pins/person/${id}`)).status).toBe(204);
    const r = await call('PUT', `/api/nav/pins/person/${ids[50]}`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('too_many');
    expect((await call('PUT', `/api/nav/pins/person/${ids[0]}`)).status).toBe(204);
  });

  it('records recents, newest first, and validates the body', async () => {
    const a = createPerson(deps.db, { name: 'A' }, now());
    const n = createNote(deps.db, { title: 'Plan', bodyMd: 'x' }, now());
    expect((await call('POST', '/api/nav/recents', { kind: 'person', id: a.id })).status).toBe(204);
    expect((await call('POST', '/api/nav/recents', { kind: 'note', id: n.id })).status).toBe(204);
    expect((await call('GET', '/api/nav')).body.recents.map((r: any) => r.title)).toEqual(['Plan', 'A']);
    expect((await call('POST', '/api/nav/recents', { kind: 'person', id: 999 })).status).toBe(404);
    for (const bad of [{ kind: 'action', id: 1 }, { kind: 'person', id: '1' }, { kind: 'person', id: 0 }, { kind: 'person', id: 1.5 }, { kind: 'person' }, { kind: 'person', id: 1, extra: 1 }]) {
      expect((await call('POST', '/api/nav/recents', bad)).status).toBe(400);
    }
    softDeleteNote(deps.db, n.id, now());
    expect((await call('POST', '/api/nav/recents', { kind: 'note', id: n.id })).status).toBe(404);
    expect((await call('GET', '/api/nav')).body.recents.map((r: any) => r.title)).toEqual(['A']);
  });
});
