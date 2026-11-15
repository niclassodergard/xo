import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { makeDeps, TEST_ORIGIN } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import { buildApp } from '../app.ts';
import { createSession, hashToken } from './sessions.ts';

// Dummy protected routes mounted like the real ones, inside the guarded /api scope.
vi.mock('../routes/people.ts', () => ({
  default: async (app: import('fastify').FastifyInstance) => {
    app.get('/people', async () => ({ secret: 'people' }));
    app.post('/people', async () => ({ secret: 'created' }));
  },
}));

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function login(deps: AppDeps) {
  const { token, csrfToken } = createSession(deps.db, deps.config, deps.now());
  return { cookie: `xo_session=${token}`, csrfToken };
}

describe('auth guard', () => {
  it('401s a protected route without a cookie, and with a bogus cookie', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const none = await app.inject({ method: 'GET', url: '/api/people' });
    expect(none.statusCode).toBe(401);
    expect(none.body).not.toContain('secret');
    const bogus = await app.inject({ method: 'GET', url: '/api/people', headers: { cookie: 'xo_session=nope' } });
    expect(bogus.statusCode).toBe(401);
    // Unauthenticated POST is 401 even with a wrong Origin (authentication is checked first).
    const post = await app.inject({ method: 'POST', url: '/api/people', headers: { origin: 'https://evil.example' } });
    expect(post.statusCode).toBe(401);
  });

  it('allows GET with a session and no CSRF header', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const res = await app.inject({ method: 'GET', url: '/api/people', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('403s POST with a session but a missing or wrong CSRF header', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const base = { method: 'POST', url: '/api/people', headers: { cookie: s.cookie, origin: TEST_ORIGIN } } as const;
    expect((await app.inject(base)).statusCode).toBe(403);
    const wrong = await app.inject({ ...base, headers: { ...base.headers, 'x-xo-csrf': 'x'.repeat(s.csrfToken.length) } });
    expect(wrong.statusCode).toBe(403);
    const short = await app.inject({ ...base, headers: { ...base.headers, 'x-xo-csrf': 'x' } });
    expect(short.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: { code: 'forbidden', message: expect.any(String) } });
  });

  it('403s POST with a missing or wrong Origin even with a valid CSRF token', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const h = { cookie: s.cookie, 'x-xo-csrf': s.csrfToken };
    expect((await app.inject({ method: 'POST', url: '/api/people', headers: h })).statusCode).toBe(403);
    for (const origin of ['https://evil.example', 'http://localhost:5174', TEST_ORIGIN + '/', 'null']) {
      const res = await app.inject({ method: 'POST', url: '/api/people', headers: { ...h, origin } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('does not take the Origin from Host or X-Forwarded-Host', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const res = await app.inject({
      method: 'POST', url: '/api/people',
      headers: { cookie: s.cookie, 'x-xo-csrf': s.csrfToken, origin: 'http://evil.example', host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows POST with session, matching Origin and CSRF token', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const res = await app.inject({
      method: 'POST', url: '/api/people',
      headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': s.csrfToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects expired and idle-expired sessions', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const deps = makeDeps({ now: () => now });
    app = await buildApp(deps);
    const a = login(deps);
    const get = (c: string) => app!.inject({ method: 'GET', url: '/api/people', headers: { cookie: c } });
    now = new Date('2026-01-05T00:00:00Z');
    expect((await get(a.cookie)).statusCode).toBe(200);
    now = new Date('2026-01-13T00:00:00Z'); // 8 days idle
    expect((await get(a.cookie)).statusCode).toBe(401);
    now = new Date('2026-01-14T00:00:00Z');
    const b = login(deps);
    for (let d = 20; d <= 38; d += 6) {
      now = new Date(Date.UTC(2026, 0, d));
      expect((await get(b.cookie)).statusCode).toBe(200);
    }
    now = new Date('2026-02-15T00:00:00Z'); // past the 30 day TTL although active
    expect((await get(b.cookie)).statusCode).toBe(401);
  });

  it('purges expired sessions when the guard starts', async () => {
    const deps = makeDeps();
    createSession(deps.db, deps.config, new Date('2025-01-01T00:00:00Z'));
    const live = createSession(deps.db, deps.config, deps.now());
    app = await buildApp(deps);
    const rows = deps.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(live.token));
  });

  it.each([
    ['GET', '/api/nothing-here'],
    ['GET', '/%61pi/people'],
    ['POST', '/ap%69/people'],
    ['GET', '/API/people'],
    ['GET', '/api%2Fpeople'],
    ['GET', '/api/people/extra'],
    ['GET', '//api/people'],
    ['GET', '///api/people'],
    ['GET', '/%5capi/people'],
    ['GET', '/%5c%2fapi/people'],
    ['POST', '//api/people'],
  ] as const)('unmatched or encoded path %s %s is 401 with no-store when unauthenticated', async (method, url) => {
    app = await buildApp(makeDeps());
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('secret');
  });

  it('an unmatched API path is a 404 (still no-store) once authenticated', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const s = login(deps);
    const res = await app.inject({ method: 'GET', url: '/api/nothing-here', headers: { cookie: s.cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the public route set is exactly GET/HEAD /api/health and POST /api/auth/login', async () => {
    const pub: string[] = [];
    app = await buildApp(makeDeps(), {
      onRoute: (r: RouteOptions) => {
        if ((r.config as { public?: boolean } | undefined)?.public === true) {
          for (const m of ([] as string[]).concat(r.method as string | string[])) pub.push(`${m} ${r.url}`);
        }
      },
    });
    await app.ready();
    expect(pub.sort()).toEqual(['GET /api/health', 'HEAD /api/health', 'POST /api/auth/login']);
  });
});
