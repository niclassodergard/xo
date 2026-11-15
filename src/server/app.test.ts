import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { makeDeps, makeRouteApp } from '../../test/helpers.ts';
import { buildApp, mustBeGuarded } from './app.ts';

// Replace two real (stub) route modules with dummy routes mounted exactly like the real ones
// (inside the guarded /api scope, as a plugin that receives { deps }).
vi.mock('./routes/people.ts', () => ({
  default: async (app: import('fastify').FastifyInstance) => {
    app.get('/people', async () => ({ secret: 'people' }));
    app.get('/people/:id', async () => ({ secret: 'person' }));
  },
}));
vi.mock('./routes/notes.ts', () => ({
  default: async (app: import('fastify').FastifyInstance) => {
    app.post('/notes', async () => ({ secret: 'note' }));
  },
}));

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('buildApp', () => {
  it('serves GET and HEAD /api/health publicly with no-store and security headers', async () => {
    app = await buildApp(makeDeps());
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const pp = String(res.headers['permissions-policy']);
    expect(pp).toContain('microphone=(self)');
    for (const f of ['camera=()', 'geolocation=()', 'payment=()', 'usb=()', 'display-capture=()']) expect(pp).toContain(f);
    const head = await app.inject({ method: 'HEAD', url: '/api/health' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['cache-control']).toBe('no-store');
  });

  it('keeps other methods on /api/health protected', async () => {
    app = await buildApp(makeDeps());
    expect((await app.inject({ method: 'POST', url: '/api/health' })).statusCode).toBe(401);
  });

  it.each([
    ['GET', '/api/people'],
    ['GET', '/api/people/5'],
    ['POST', '/api/notes'],
    ['GET', '/api/auth/session'],
    // POST /api/auth/login is public since step 2 (covered in routes/auth.test.ts).
    ['GET', '/api/unknown'],
    ['GET', '/api/health/extra'],
    ['GET', '/api'],
    ['GET', '/%61pi/people'],
    ['GET', '/a%70i/people/5'],
    ['POST', '/ap%69/notes'],
    ['GET', '/%61pi/unknown'],
    ['GET', '/api%2Fpeople'],
    ['GET', '/%41%50%49/people'],
    ['GET', '/API/people'],
    ['GET', '/Api%2fPeople'],
    ['GET', '/%2561pi/people'],
    ['GET', '/api/people?/api/health'],
  ] as const)('fails closed: %s %s -> 401 with no-store, no data', async (method, url) => {
    app = await buildApp(makeDeps());
    const res = await app.inject({ method, url });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: expect.any(String) } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('secret');
  });

  it.each(['/api/%', '/%zz/api/people'])('rejects malformed URL %s before routing, without data', async (url) => {
    app = await buildApp(makeDeps());
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'bad_request', message: 'Bad request' } });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('secret');
  });

  it('exposes every registered route through opts.onRoute', async () => {
    const seen: string[] = [];
    app = await buildApp(makeDeps(), { onRoute: (r: RouteOptions) => { seen.push(`${String(r.method)} ${r.url}`); } });
    await app.ready();
    expect(seen.some((x) => x.includes('GET') && x.endsWith(' /api/health'))).toBe(true);
    expect(seen).toContain('GET /api/people/:id');
    expect(seen).toContain('POST /api/notes');
  });
});

describe('clientDir option', () => {
  it('serves the SPA from another directory, and the guard still holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-client-'));
    try {
      writeFileSync(join(dir, 'index.html'), '<!doctype html><title>other-client</title>');
      writeFileSync(join(dir, 'app.js'), 'console.log(1)');
      app = await buildApp(makeDeps(), { clientDir: dir });
      const html = await app.inject({ method: 'GET', url: '/#/x', headers: { accept: 'text/html' } });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain('other-client');
      const js = await app.inject({ method: 'GET', url: '/app.js' });
      expect(js.statusCode).toBe(200);
      // a deep link falls back to index.html; API paths do not
      const deep = await app.inject({ method: 'GET', url: '/people/5', headers: { accept: 'text/html' } });
      expect(deep.body).toContain('other-client');
      const api = await app.inject({ method: 'GET', url: '/api/projects' });
      expect(api.statusCode).toBe(401);
      expect(api.body).not.toContain('other-client');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the route tripwire installed when clientDir is used', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-client-'));
    try {
      writeFileSync(join(dir, 'index.html'), 'x');
      app = await buildApp(makeDeps(), { clientDir: dir });
      expect(() => app!.get('/api/rootlevel', async () => ({ secret: 'x' }))).toThrow(/guarded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not serve files outside the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xo-client-'));
    try {
      writeFileSync(join(dir, 'index.html'), 'x');
      app = await buildApp(makeDeps(), { clientDir: dir });
      for (const url of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
        const res = await app.inject({ method: 'GET', url });
        expect(res.body).not.toContain('"name"');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('registers the projects routes behind the guard', async () => {
    app = await buildApp(makeDeps());
    for (const [method, url] of [['GET', '/api/projects'], ['POST', '/api/projects'], ['GET', '/api/projects/1'], ['PUT', '/api/projects/1/people/2']] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('unguarded /api route protection', () => {
  it('throws when a route under /api is registered outside the guarded scope', async () => {
    app = await buildApp(makeDeps());
    expect(() => app!.get('/api/rootlevel', async () => ({ secret: 'x' }))).toThrow(/guarded/);
    expect(() => app!.get('/%61pi/rootlevel', async () => ({ secret: 'x' }))).toThrow(/guarded/);
    expect(() => app!.get('/API/rootlevel', async () => ({ secret: 'x' }))).toThrow(/guarded/);
  });

  it('allows non-API root routes and still boots normally', async () => {
    app = await buildApp(makeDeps());
    expect(() => app!.get('/other', async () => ({ ok: true }))).not.toThrow();
    await app.ready();
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });
});

describe('shared Fastify options', () => {
  const schemaApp = async () =>
    makeRouteApp(async (a) => {
      a.post('/echo', {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['a'],
            properties: {
              a: { type: 'string', maxLength: 3 },
              personId: { type: 'integer' },
              maybe: { type: ['integer', 'null'] },
            },
          },
        },
      }, async (req) => req.body);
    }, makeDeps());

  it('rejects unknown body properties instead of stripping them', async () => {
    app = await schemaApp();
    const ok = await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'x' } });
    expect(ok.statusCode).toBe(200);
    const extra = await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'x', b: 1 } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.code).toBe('validation_error');
    expect((await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'toolong' } })).statusCode).toBe(400);
  });

  it('does not coerce types: null is not an integer, 123 is not a string', async () => {
    app = await schemaApp();
    expect((await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'x', personId: null } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'x', personId: '5' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 123 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/echo', payload: { a: 'x', maybe: null } })).statusCode).toBe(200);
  });

  it('returns the error shape for 404 and hides internal errors', async () => {
    app = await makeRouteApp(async (a) => {
      a.get('/boom', async () => { throw new Error('secret detail'); });
      a.get('/odd', async () => { throw Object.assign(new Error('internal 4xx detail'), { statusCode: 400 }); });
    }, makeDeps());
    const nf = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('not_found');
    const boom = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(boom.statusCode).toBe(500);
    expect(boom.body).not.toContain('secret detail');
    const odd = await app.inject({ method: 'GET', url: '/api/odd' });
    expect(odd.statusCode).toBe(500);
    expect(odd.body).not.toContain('internal 4xx detail');
  });

  it('relays Fastify client errors (bad JSON) as 400', async () => {
    app = await schemaApp();
    const res = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/json' }, payload: '{bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBeTruthy();
  });

  it('makeRouteApp has cookie support registered', async () => {
    app = await makeRouteApp(async (a) => {
      a.get('/c', async (req, reply) => { reply.setCookie('k', 'v'); return { has: typeof req.cookies }; });
    }, makeDeps());
    const res = await app.inject({ method: 'GET', url: '/api/c' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['set-cookie']).toContain('k=v');
  });
});

describe('mustBeGuarded (route registration tripwire)', () => {
  it.each(['/api', '/api/x', '/API/x', '//api/x', '/%61pi/x', '/%5capi/x', '/:x', '/:x/api', '/*', '*', '/:a/:b', ':x', '/ap*', '/a*', '/a:x', '/ap:x', '/a(b)'])(
    '%s must live in the guarded scope',
    (url) => { expect(mustBeGuarded(url)).toBe(true); },
  );
  it.each(['/', '/index.html', '/assets/app.js', '/favicon.ico', '/apix', '/x/:id'])(
    '%s is an ordinary root route',
    (url) => { expect(mustBeGuarded(url)).toBe(false); },
  );
});
