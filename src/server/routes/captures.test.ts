import { request as httpRequest } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDeps, makeRouteApp } from '../../../test/helpers.ts';
import { LIMITS } from '../../shared/api.ts';
import type { AppDeps } from '../deps.ts';
import { listActions } from '../repos/actions.ts';
import { createNote } from '../repos/notes.ts';
import { createPerson } from '../repos/people.ts';
import type { Answerer, AnswerOutput } from '../llm/types.ts';
import { LlmError } from '../llm/types.ts';
import { createProject, softDeleteProject } from '../repos/projects.ts';
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

  it('accepts a projectId answer (create flow: p then the picked project)', async () => {
    const p = createProject(deps.db, { title: 'Apollo' }, deps.now());
    const q = (await call('POST', '/api/captures', { text: '/todo #zeta call', source: 'text' })).body;
    expect(q.question.type).toBe('unknown_project');
    const done = await call('POST', `/api/captures/${q.id}/answer`, { projectId: p.id });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'filed', draft: { projectId: p.id, projectName: null } });
    expect(listActions(deps.db)[0]!.projectId).toBe(p.id);
  });

  it('a projectId deleted since the question is not a 500: the item files without a project', async () => {
    const p = createProject(deps.db, { title: 'Apollo' }, deps.now());
    const q = (await call('POST', '/api/captures', { text: '/todo #zeta call', source: 'text' })).body;
    softDeleteProject(deps.db, p.id, deps.now());
    const done = await call('POST', `/api/captures/${q.id}/answer`, { projectId: p.id });
    expect(done.status).toBe(200);
    expect(done.body.draft.projectId).toBeNull();
    expect(listActions(deps.db)[0]!.projectId).toBeNull();
  });

  it('a projectId that never existed, or one sent to a non-project question, is a 400 bad_answer', async () => {
    const p = createProject(deps.db, { title: 'Apollo' }, deps.now());
    const q = (await call('POST', '/api/captures', { text: '/todo #zeta call', source: 'text' })).body;
    expect((await call('POST', `/api/captures/${q.id}/answer`, { projectId: 9999 })).body.error.code).toBe('bad_answer');
    const k = (await call('POST', '/api/captures', { text: 'x ??', source: 'text' })).body;
    expect((await call('POST', `/api/captures/${k.id}/answer`, { projectId: p.id })).status).toBe(400);
  });

  it('a pending capture whose project vanished has question null; s files it, d discards (route)', async () => {
    const p = createProject(deps.db, { title: 'Budget' }, deps.now());
    const a = (await call('POST', '/api/captures', { text: '/note budget review', source: 'text' })).body;
    const b = (await call('POST', '/api/captures', { text: '/note budget again', source: 'text' })).body;
    softDeleteProject(deps.db, p.id, deps.now());
    const list = (await call('GET', '/api/captures')).body.captures;
    expect(list.map((c: any) => [c.status, c.question])).toEqual([['pending', null], ['pending', null]]);
    expect((await call('POST', `/api/captures/${a.id}/answer`, { key: 's' })).body).toMatchObject({ status: 'filed', draft: { projectId: null } });
    expect((await call('POST', `/api/captures/${b.id}/answer`, { key: 'd' })).body.status).toBe('discarded');
  });

  it('rejects malformed answers and unknown ids', async () => {
    const q = (await call('POST', '/api/captures', { text: 'x ??', source: 'text' })).body;
    for (const body of [{}, { key: 'ab' }, { key: 'n', personId: 1 }, { personId: 0 }, { personId: '1' }, { projectId: 0 }, { projectId: '1' }, { key: 'n', projectId: 1 }, { personId: 1, projectId: 1 }, { key: 5 }, { other: 1 }]) {
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

describe('POST /api/captures/:id/ask', () => {
  const askText = async (text = '/ask what is the budget?') => (await call('POST', '/api/captures', { text, source: 'text' })).body as { id: number; status: string };
  const seed = (): void => { createNote(deps.db, { title: 'Budget', bodyMd: 'budget is fine' }, deps.now()); };

  it('answers an asked capture: 200 Capture with answer and sources, then 409 not_asked', async () => {
    seed();
    const c = await askText();
    expect(c.status).toBe('asked');
    const r = await call('POST', `/api/captures/${c.id}/ask`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.id, status: 'answered', answer: { redacted: false, sources: [{ kind: 'note', title: 'Budget' }] } });
    const again = await call('POST', `/api/captures/${c.id}/ask`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_asked');
    // The list returns the same answered capture.
    const list = await call('GET', '/api/captures');
    expect(list.body.captures.at(-1)).toMatchObject({ id: c.id, status: 'answered' });
  });

  it('404 for a missing capture, 409 for a capture that is not asked, 400 for a bad id, body or query', async () => {
    expect((await call('POST', '/api/captures/9999/ask')).status).toBe(404);
    const filed = (await call('POST', '/api/captures', { text: '/note x', source: 'text' })).body;
    expect((await call('POST', `/api/captures/${filed.id}/ask`)).status).toBe(409);
    expect((await call('POST', '/api/captures/abc/ask')).status).toBe(400);
    seed();
    const c = await askText();
    expect((await call('POST', `/api/captures/${c.id}/ask`, { text: 'x' })).status).toBe(400);
    expect((await app.inject({ method: 'POST', url: `/api/captures/${c.id}/ask?x=1` })).statusCode).toBe(400);
    expect(((await call('GET', '/api/captures')).body.captures.at(-1)).status).toBe('asked'); // nothing happened
  });

  it('503 no_llm without an answerer; the capture stays asked', async () => {
    const bare = makeDeps({ answerer: null });
    const a2 = await makeRouteApp(capturesRoutes, bare);
    const created = (await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number };
    const res = await a2.inject({ method: 'POST', url: `/api/captures/${created.id}/ask` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('no_llm');
    await a2.close();
  });

  it('502 llm_failed when the answerer fails: no upstream text in the response, the capture stays asked, a retry works', async () => {
    seed();
    let fail = true;
    const answerer: Answerer = {
      async answer(i): Promise<AnswerOutput> {
        if (fail) throw new LlmError('upstream: sk-or-SECRET budget is fine');
        return { answer: 'ok', cited: [i.excerpts[0]!.ref] };
      },
    };
    const d = makeDeps({ answerer });
    const a2 = await makeRouteApp(capturesRoutes, d);
    const created = (await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number };
    createNote(d.db, { bodyMd: 'budget is fine' }, d.now());
    const res = await a2.inject({ method: 'POST', url: `/api/captures/${created.id}/ask` });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('llm_failed');
    expect(res.body).not.toContain('SECRET');
    expect(res.body).not.toContain('budget');
    const list = (await a2.inject({ method: 'GET', url: '/api/captures' })).json() as { captures: { status: string }[] };
    expect(list.captures.at(-1)!.status).toBe('asked');
    fail = false;
    expect((await a2.inject({ method: 'POST', url: `/api/captures/${created.id}/ask` })).statusCode).toBe(200);
    await a2.close();
  });

  describe('limits', () => {
    const hanging = (): { answerer: Answerer; release: () => void; started: () => number } => {
      const waiters: (() => void)[] = [];
      let n = 0;
      return {
        answerer: { answer: () => { n++; return new Promise<AnswerOutput>((res) => { waiters.push(() => res({ answer: 'ok', cited: [] })); }); } },
        release: () => { while (waiters.length) waiters.shift()!(); },
        started: () => n,
      };
    };

    it('429 busy (Retry-After) when 2 answers are in progress, and the slot is free again afterwards', async () => {
      const h = hanging();
      const d = makeDeps({ answerer: h.answerer });
      const a2 = await makeRouteApp(capturesRoutes, d);
      createNote(d.db, { bodyMd: 'budget' }, d.now());
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) ids.push(((await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number }).id);
      const p1 = a2.inject({ method: 'POST', url: `/api/captures/${ids[0]}/ask` });
      const p2 = a2.inject({ method: 'POST', url: `/api/captures/${ids[1]}/ask` });
      await vi.waitFor(() => expect(h.started()).toBe(2));
      const busy = await a2.inject({ method: 'POST', url: `/api/captures/${ids[2]}/ask` });
      expect(busy.statusCode).toBe(429);
      expect(busy.json().error.code).toBe('busy');
      expect(Number(busy.headers['retry-after'])).toBeGreaterThan(0);
      expect(h.started()).toBe(2); // the refused request never reached the model
      h.release();
      expect((await p1).statusCode).toBe(200);
      expect((await p2).statusCode).toBe(200);
      const next = a2.inject({ method: 'POST', url: `/api/captures/${ids[2]}/ask` }); // follow-up succeeds: no slot leaked
      await vi.waitFor(() => expect(h.started()).toBe(3));
      h.release();
      expect((await next).statusCode).toBe(200);
      await a2.close();
    });

    it('the deadline frees the slot of an answerer that never returns', async () => {
      const never: Answerer = { answer: () => new Promise<AnswerOutput>(() => undefined) };
      const d = makeDeps({ answerer: never });
      const a2 = await makeRouteApp(async (app, o) => capturesRoutes(app, { deps: o.deps, askDeadlineMs: 40 }), d);
      createNote(d.db, { bodyMd: 'budget' }, d.now());
      const ids: number[] = [];
      for (let i = 0; i < 4; i++) ids.push(((await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number }).id);
      const first = await Promise.all([ids[0], ids[1]].map((id) => a2.inject({ method: 'POST', url: `/api/captures/${id}/ask` })));
      expect(first.map((r) => r.statusCode)).toEqual([502, 502]);
      // Both slots are free again: two more can start (and fail by the deadline as well, not with 429).
      const second = await Promise.all([ids[2], ids[3]].map((id) => a2.inject({ method: 'POST', url: `/api/captures/${id}/ask` })));
      expect(second.map((r) => r.statusCode)).toEqual([502, 502]);
      await a2.close();
    });

    it('429 rate_limited after 20 requests in a minute, with Retry-After; the window then slides', async () => {
      let now = new Date('2026-01-15T12:00:00.000Z');
      const d = makeDeps({ now: () => now });
      const a2 = await makeRouteApp(capturesRoutes, d);
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) codes.push((await a2.inject({ method: 'POST', url: '/api/captures/9999/ask' })).statusCode);
      expect(codes.slice(0, 20).every((c) => c === 404)).toBe(true);
      expect(codes[20]).toBe(429);
      const limited = await a2.inject({ method: 'POST', url: '/api/captures/9999/ask' });
      expect(limited.json().error.code).toBe('rate_limited');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      now = new Date(now.getTime() + 61_000);
      expect((await a2.inject({ method: 'POST', url: '/api/captures/9999/ask' })).statusCode).toBe(404);
      await a2.close();
    });
  });
});

describe('undo and reclassify of questions over HTTP', () => {
  it('undo erases the answer at once; reclassify returns to the kind question', async () => {
    createNote(deps.db, { bodyMd: 'budget is fine' }, deps.now());
    const mk = async () => (await call('POST', '/api/captures', { text: '/ask budget?', source: 'text' })).body as { id: number };
    const a = await mk();
    await call('POST', `/api/captures/${a.id}/ask`);
    const undone = await call('POST', `/api/captures/${a.id}/undo`);
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ status: 'discarded', answer: null });
    expect(deps.db.prepare('SELECT answer, sources FROM captures WHERE id = ?').get(a.id)).toEqual({ answer: null, sources: null });

    const b = await mk();
    await call('POST', `/api/captures/${b.id}/ask`);
    const re = await call('POST', `/api/captures/${b.id}/reclassify`);
    expect(re.body).toMatchObject({ status: 'pending', question: { type: 'kind' }, answer: null });
    const kind = await call('POST', `/api/captures/${b.id}/answer`, { key: 'q' });
    expect(kind.body).toMatchObject({ status: 'asked' });
  });
});

describe('POST /api/captures/:id/ask: one answer per capture, and client disconnects', () => {
  it('429 busy (Retry-After) for a second ask of a capture that is being answered; only one call reaches the model', async () => {
    let release!: () => void;
    let calls = 0;
    const answerer: Answerer = {
      answer: async () => { calls++; await new Promise<void>((r) => { release = r; }); return { answer: 'ok', cited: [] }; },
    };
    const d = makeDeps({ answerer });
    const a2 = await makeRouteApp(capturesRoutes, d);
    createNote(d.db, { bodyMd: 'budget' }, d.now());
    const id = ((await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number }).id;
    const first = a2.inject({ method: 'POST', url: `/api/captures/${id}/ask` });
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await a2.inject({ method: 'POST', url: `/api/captures/${id}/ask` });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('busy');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toBe(1);
    release();
    expect((await first).statusCode).toBe(200);
    await a2.close();
  });

  it('a client that disconnects mid-ask aborts the call and frees its slot: two further asks run at once', async () => {
    const signals: AbortSignal[] = [];
    const waiters: (() => void)[] = [];
    let started = 0;
    const answerer: Answerer = {
      answer: (_i, signal) => {
        started++;
        if (signals.length === 0 && signal) { signals.push(signal); return new Promise<AnswerOutput>(() => undefined); } // ignores the abort
        return new Promise<AnswerOutput>((res) => { waiters.push(() => res({ answer: 'ok', cited: [] })); });
      },
    };
    const d = makeDeps({ answerer });
    const a2 = await makeRouteApp(capturesRoutes, d);
    await a2.listen({ port: 0, host: '127.0.0.1' });
    const port = (a2.server.address() as { port: number }).port;
    try {
      createNote(d.db, { bodyMd: 'budget' }, d.now());
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) ids.push(((await a2.inject({ method: 'POST', url: '/api/captures', payload: { text: '/ask budget?', source: 'text' } })).json() as { id: number }).id);

      const req = httpRequest({ host: '127.0.0.1', port, path: `/api/captures/${ids[0]}/ask`, method: 'POST' });
      req.on('error', () => undefined);
      req.end();
      await vi.waitFor(() => expect(started).toBe(1));
      req.destroy(); // the client goes away while the model is "working"
      await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));

      // Both slots are usable: two asks are accepted at the same time (neither is 429 busy).
      const p1 = a2.inject({ method: 'POST', url: `/api/captures/${ids[1]}/ask` });
      const p2 = a2.inject({ method: 'POST', url: `/api/captures/${ids[2]}/ask` });
      await vi.waitFor(() => expect(started).toBe(3));
      while (waiters.length) waiters.shift()!();
      expect([(await p1).statusCode, (await p2).statusCode]).toEqual([200, 200]);
    } finally {
      await a2.close();
    }
  });
});
