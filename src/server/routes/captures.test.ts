import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import { LIMITS } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { listActions } from '../repos/actions.ts';
import { createPerson } from '../repos/people.ts';
import capturesRoutes from './captures.ts';

let app: FastifyInstance;
let deps: AppDeps;
beforeEach(async () => {
  deps = makeDeps();
  app = await makeRouteApp(capturesRoutes, deps);
});
afterEach(async () => { await app.close(); });

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
}

describe('POST /api/captures', () => {
  it('returns 201 with a filed capture for a prefix', async () => {
    const r = await call('POST', '/api/captures', { text: '/todo call the bank', source: 'text' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'filed', classifiedBy: 'prefix', source: 'text', deleted: false });
  });

  it('returns 201 with a pending capture and a question', async () => {
    const r = await call('POST', '/api/captures', { text: 'hmm ??', source: 'voice' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', source: 'voice', question: { type: 'kind' } });
  });

  it('validates the body', async () => {
    expect((await call('POST', '/api/captures', { text: 'x' })).status).toBe(400);
    expect((await call('POST', '/api/captures', { text: '', source: 'text' })).status).toBe(400);
    expect((await call('POST', '/api/captures', { text: 'x', source: 'fax' })).status).toBe(400);
    expect((await call('POST', '/api/captures', { text: 'x', source: 'text', extra: 1 })).status).toBe(400);
    expect((await call('POST', '/api/captures', { text: 'a'.repeat(LIMITS.captureText + 1), source: 'text' })).status).toBe(400);
    const edge = await call('POST', '/api/captures', { text: '/note ' + 'a'.repeat(LIMITS.captureText - 6), source: 'text' });
    expect(edge.status).toBe(201);
  });

  it('answers 400 for text that is empty after parsing', async () => {
    const r = await call('POST', '/api/captures', { text: '/todo', source: 'text' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  });
});

describe('answer, undo, reclassify', () => {
  it('runs the question flow through the API', async () => {
    const q = (await call('POST', '/api/captures', { text: '/todo @bob call', source: 'text' })).body;
    expect(q.question.type).toBe('unknown_person');
    const bad = await call('POST', `/api/captures/${q.id}/answer`, { key: 'z' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_answer');
    const done = await call('POST', `/api/captures/${q.id}/answer`, { key: 'c' });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('filed');
    expect((await call('POST', `/api/captures/${q.id}/answer`, { key: 'c' })).status).toBe(409);
  });

  it('accepts a personId answer', async () => {
    const carl = createPerson(deps.db, { name: 'Carl' }, deps.now());
    const q = (await call('POST', '/api/captures', { text: '/todo @bob call', source: 'text' })).body;
    const done = await call('POST', `/api/captures/${q.id}/answer`, { personId: carl.id });
    expect(done.body.draft.personId).toBe(carl.id);
    expect(listActions(deps.db)[0]!.personId).toBe(carl.id);
  });

  it('rejects malformed answers and unknown ids', async () => {
    const q = (await call('POST', '/api/captures', { text: 'x ??', source: 'text' })).body;
    for (const body of [{}, { key: 'ab' }, { key: 'n', personId: 1 }, { personId: 0 }, { personId: '1' }, { key: 5 }, { other: 1 }]) {
      expect((await call('POST', `/api/captures/${q.id}/answer`, body)).status).toBe(400);
    }
    expect((await call('POST', '/api/captures/9999/answer', { key: 'n' })).status).toBe(404);
    expect((await call('POST', '/api/captures/abc/answer', { key: 'n' })).status).toBe(400);
  });

  it('undo then undo again is 409; reclassify of a non-filed capture is 409', async () => {
    const c = (await call('POST', '/api/captures', { text: '/todo x', source: 'text' })).body;
    const u = await call('POST', `/api/captures/${c.id}/undo`);
    expect(u.status).toBe(200);
    expect(u.body.status).toBe('undone');
    expect((await call('POST', `/api/captures/${c.id}/undo`)).status).toBe(409);
    expect((await call('POST', `/api/captures/${c.id}/reclassify`)).status).toBe(409);
    expect((await call('POST', '/api/captures/9999/undo')).status).toBe(404);
    expect((await call('POST', '/api/captures/9999/reclassify')).status).toBe(404);
  });

  it('reclassify returns to a kind question and the old item is gone', async () => {
    const c = (await call('POST', '/api/captures', { text: '/todo x', source: 'text' })).body;
    const r = await call('POST', `/api/captures/${c.id}/reclassify`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending', question: { type: 'kind' } });
    expect(listActions(deps.db)).toHaveLength(0);
  });

  it('rejects a body on undo/reclassify', async () => {
    const c = (await call('POST', '/api/captures', { text: '/todo x', source: 'text' })).body;
    expect((await call('POST', `/api/captures/${c.id}/undo`, { a: 1 })).status).toBe(400);
  });
});

describe('items deleted elsewhere', () => {
  it('undo and reclassify answer 409 gone without any text, and the list stays redacted', async () => {
    const c = (await call('POST', '/api/captures', { text: '/note very private', source: 'text' })).body;
    deps.db.prepare('UPDATE notes SET deleted_at = ?').run(deps.now().toISOString());
    for (const path of ['undo', 'reclassify']) {
      const r = await call('POST', `/api/captures/${c.id}/${path}`);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('gone');
      expect(JSON.stringify(r.body)).not.toContain('private');
    }
    const list = await call('GET', '/api/captures');
    expect(list.body.captures[0]).toMatchObject({ deleted: true, text: '' });
    expect(JSON.stringify(list.body)).not.toContain('private');
  });
});

describe('GET /api/captures', () => {
  it('lists and pages, and validates the query', async () => {
    for (let i = 1; i <= 3; i++) await call('POST', '/api/captures', { text: `/note n${i}`, source: 'text' });
    const all = await call('GET', '/api/captures');
    expect(all.body.captures.map((c: any) => c.text)).toEqual(['/note n1', '/note n2', '/note n3']);
    const page = await call('GET', '/api/captures?limit=1');
    expect(page.body.captures).toHaveLength(1);
    const before = await call('GET', `/api/captures?limit=5&before=${page.body.captures[0].id}`);
    expect(before.body.captures).toHaveLength(2);
    for (const q of ['limit=0', 'limit=201', 'limit=x', 'before=-1', 'foo=1']) {
      expect((await call('GET', `/api/captures?${q}`)).status).toBe(400);
    }
  });

  it('hides the text of captures whose item was deleted', async () => {
    const c = (await call('POST', '/api/captures', { text: '/note very private', source: 'text' })).body;
    deps.db.prepare('UPDATE notes SET deleted_at = ?').run('2026-01-01T00:00:00.000Z');
    const r = await call('GET', '/api/captures');
    expect(r.body.captures[0]).toMatchObject({ id: c.id, text: '', summary: '(deleted)', deleted: true });
    expect(JSON.stringify(r.body)).not.toContain('private');
  });
});
