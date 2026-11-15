import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from 'fastify';
import { buildApp } from '../../src/server/app.ts';
import { base32Encode, totpAt } from '../../src/server/auth/totp.ts';
import { setupUser } from '../../src/server/cli/setup.ts';
import type { AppDeps } from '../../src/server/deps.ts';
import { pickLlm } from '../../src/server/llm/pick.ts';
import { purgeDeleted } from '../../src/server/repos/purge.ts';
import type { Action, Capture, NavItem, Note, Project } from '../../src/shared/types.ts';
import type { NavResponse, ProjectDetailResponse, ProjectsListResponse } from '../../src/shared/api.ts';
import { FIXED_NOW, makeDeps, makeTestConfig, TEST_ORIGIN } from '../helpers.ts';

// Full buildApp with the REAL guard, real login route and real repos. Only the LLM is faked (the fake
// classifier, or a fake `fetch` behind the real OpenRouter client). No network, no key file.

const PASSWORD = 'correct horse battery';
const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const SCRYPT = { N: 16, r: 8, p: 1 } as const; // cheap parameters; the login route reads them from the hash
const API_KEY = 'sk-or-test-SECRET-KEY-0123456789';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Creates the user through the real setup function. setupUser consumes the confirming code's TOTP step,
 * so it is confirmed with the previous step's code (still inside the +-1 window); logging in with the
 * current step's code then works.
 */
async function seedUser(deps: AppDeps): Promise<void> {
  const previous = new Date(deps.now().getTime() - 30_000);
  await setupUser(deps.db, { password: PASSWORD, secret: SECRET, code: totpAt(SECRET, previous), now: previous, scryptParams: SCRYPT });
}

interface Session { cookie: string; csrf: string }

async function login(a: FastifyInstance, deps: AppDeps, origin = TEST_ORIGIN): Promise<Session> {
  const res = await a.inject({
    method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: PASSWORD, totp: totpAt(SECRET, deps.now()) },
  });
  expect(res.statusCode).toBe(200);
  const c = res.cookies.find((x) => x.name.endsWith('xo_session'));
  expect(c).toBeDefined();
  return { cookie: `${c!.name}=${c!.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
}

function authed(a: FastifyInstance, s: Session, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<LightMyRequestResponse> {
  return a.inject({
    method, url, payload,
    headers: { cookie: s.cookie, ...(method === 'GET' ? {} : { origin: TEST_ORIGIN, 'x-xo-csrf': s.csrf }) },
  });
}

/** The route (pattern) that actually answered the latest request; null if no route did (404 / fallback). */
let answered: string | null = null;

async function boot(overrides: Partial<AppDeps> = {}): Promise<{ a: FastifyInstance; deps: AppDeps; routes: { method: string; url: string; public: boolean }[] }> {
  const deps = makeDeps(overrides);
  await seedUser(deps);
  const routes: { method: string; url: string; public: boolean }[] = [];
  const a = await buildApp(deps, {
    onRoute: (r: RouteOptions) => {
      for (const m of ([] as string[]).concat(r.method as string | string[])) {
        routes.push({ method: m, url: r.url, public: (r.config as { public?: boolean } | undefined)?.public === true });
      }
      // Record which route really answered (onResponse runs for 401/403 answers too, but not for
      // requests that matched no route), so the sweep cannot pass by hitting the wrong handler.
      const prev = r.onResponse;
      const record = (req: { routeOptions: { url?: string } }, _reply: unknown, done: () => void): void => {
        answered = req.routeOptions.url ?? null;
        done();
      };
      r.onResponse = (Array.isArray(prev) ? [...prev, record] : prev ? [prev, record] : [record]) as RouteOptions['onResponse'];
    },
  });
  await a.ready();
  app = a;
  return { a, deps, routes };
}

/** Fills `:param` segments with a plausible value, so the path matches the registered route. */
const fill = (url: string): string => {
  // Params with a regex or wildcards cannot be filled blindly: fail loudly instead of guessing.
  if (/[()*]/.test(url) || /:[A-Za-z_]+\(/.test(url)) throw new Error(`route ${url} has a regex or wildcard param: teach fill() about it`);
  return url.replace(/:[A-Za-z_]+/g, '1');
};

/** Spellings of one path that the router decodes to the same /api route. */
function variants(path: string): string[] {
  const rest = path.slice('/api'.length);
  return [
    path,
    `/API${rest}`,
    `/Api${rest}`,
    `/%61pi${rest}`, // %61 = a
    `/%41PI${rest}`, // %41 = A
    `/a%70i${rest}`, // %70 = p
    `/ap%69${rest}`, // %69 = i
    `/api/%${rest.charCodeAt(1).toString(16)}${rest.slice(2)}`, // first letter of the next segment, e.g. /api/%70rojects
  ];
}

describe('route sweep: nothing under /api is reachable without a session', () => {
  it('every non-public route answers 401 (plus encoded and mixed-case spellings), nothing leaks', async () => {
    const { a, routes } = await boot();
    // Anything outside /api is the static client: pinned below to `/`, `/index.html` and real files.
    const outside = routes.filter((r) => !r.url.startsWith('/api/'));
    const protectedRoutes = routes.filter((r) => r.url.startsWith('/api/') && !r.public);
    // The sweep must really have found the app's routes (not pass vacuously).
    const keys = routes.map((r) => `${r.method} ${r.url}`);
    for (const must of [
      'GET /api/people', 'POST /api/people', 'GET /api/people/:id', 'POST /api/notes', 'GET /api/actions',
      'POST /api/captures', 'POST /api/captures/:id/undo', 'POST /api/search', 'POST /api/voice/transcribe',
      'POST /api/meetings/:id/end', 'POST /api/auth/logout', 'GET /api/auth/session',
      // v0.2: projects, pins and recents
      'POST /api/captures/:id/answer', 'POST /api/captures/:id/ask',
      'GET /api/projects', 'POST /api/projects', 'GET /api/projects/:id', 'PATCH /api/projects/:id', 'DELETE /api/projects/:id',
      'PUT /api/projects/:id/people/:personId', 'DELETE /api/projects/:id/people/:personId',
      'GET /api/nav', 'PUT /api/nav/pins/:kind/:id', 'DELETE /api/nav/pins/:kind/:id', 'POST /api/nav/recents',
    ]) expect(keys).toContain(must);
    expect(protectedRoutes.length).toBeGreaterThan(25);
    let requests = 0;
    for (const r of protectedRoutes) {
      const canonical = fill(r.url);
      for (const path of variants(canonical)) {
        // `/API`, `/Api` and `/%41PI` (= /API) are not the route's spelling: the router does not match them, so they are
        // answered by the fail-closed fallback. The other spellings decode to the route itself.
        const viaRoute = !/^\/(API|Api|%41PI)/.test(path);
        // With the right Origin (so 403 cannot hide a missing 401 check) and without it.
        for (const headers of [{}, { origin: TEST_ORIGIN }]) {
          answered = null;
          const res = await a.inject({ method: r.method as 'GET', url: path, headers });
          requests++;
          expect(res.statusCode, `${r.method} ${path}`).toBe(401);
          expect(res.headers['cache-control']).toBe('no-store');
          if (viaRoute) expect(answered, `${r.method} ${path} must be answered by route ${r.url}`).toBe(r.url);
          else expect(answered, `${r.method} ${path} must be answered by the fallback`).toBeNull();
          if (r.method !== 'HEAD') expect(res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required' } });
        }
      }
    }
    expect(requests).toBeGreaterThan(protectedRoutes.length * 7);

    // Non-/api routes: only the static client (dist/client), read-only. A new GET at the root fails here.
    const dist = resolve(import.meta.dirname, '../../dist/client');
    if (!existsSync(dist)) expect(outside, 'no dist/client, so no static routes').toEqual([]);
    const files = new Set(existsSync(dist) ? readdirSync(dist, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => '/' + join(e.parentPath.slice(dist.length), e.name).replace(/^\/+/, '')) : []);
    for (const r of outside) {
      expect(['GET', 'HEAD'], `${r.method} ${r.url}`).toContain(r.method);
      expect(r.url === '/' || r.url === '/index.html' || files.has(r.url), `unexpected non-/api route ${r.method} ${r.url}`).toBe(true);
    }
  });

  it('a bogus, truncated or other-cookie-name session is still 401', async () => {
    const { a } = await boot();
    for (const cookie of ['xo_session=nope', 'xo_session=', `xo_session=${'a'.repeat(500)}`, '__Host-xo_session=nope', 'other=1']) {
      const res = await a.inject({ method: 'GET', url: '/api/people', headers: { cookie } });
      expect(res.statusCode, cookie).toBe(401);
    }
  });

  it('unmatched /api paths (also encoded) are 401 without a session and 404 with one; malformed encoding is refused', async () => {
    const { a, deps } = await boot();
    for (const url of ['/api/nothing', '/API/nothing', '/%61pi/nothing', '/api%2fnothing', '/api/people/1/nothing', '//api/people', '/%5capi/people']) {
      const res = await a.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    const s = await login(a, deps);
    const nf = await authed(a, s, 'GET', '/api/nothing');
    expect(nf.statusCode).toBe(404);
    expect(nf.headers['cache-control']).toBe('no-store');
    const bad = await a.inject({ method: 'GET', url: '/api/%zz' });
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['cache-control']).toBe('no-store');
  });

  it('the public routes are exactly GET/HEAD /api/health and POST /api/auth/login', async () => {
    const { routes } = await boot();
    const pub = routes.filter((r) => r.public).map((r) => `${r.method} ${r.url}`).sort();
    expect(pub).toEqual(['GET /api/health', 'HEAD /api/health', 'POST /api/auth/login']);
    expect(routes.length).toBeGreaterThan(pub.length); // the registry is not just the public set
  });

  it('health is public and minimal; other methods on it are not public', async () => {
    const { a } = await boot();
    const ok = await a.inject({ method: 'GET', url: '/api/health' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await a.inject({ method: 'HEAD', url: '/api/health' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'POST', url: '/api/health', headers: { origin: TEST_ORIGIN } })).statusCode).toBe(401);
  });
});

describe('CSRF and Origin enforcement', () => {
  it('login: wrong or missing Origin is 403, non-JSON is 415; neither reaches credential checking', async () => {
    const { a, deps } = await boot();
    const payload = { password: PASSWORD, totp: totpAt(SECRET, deps.now()) };
    for (const headers of [{}, { origin: 'https://evil.example' }, { origin: `${TEST_ORIGIN}.evil.example` }, { origin: 'null' }]) {
      const res = await a.inject({ method: 'POST', url: '/api/auth/login', headers, payload });
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const form = await a.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN, 'content-type': 'text/plain' }, payload: 'x',
    });
    expect(form.statusCode).toBe(415);
    // The valid code was never consumed by the refused attempts.
    expect((await login(a, deps)).csrf).toBeTruthy();
  });

  it('with a session: every state-changing route is 403 without the CSRF header, with a wrong one, or with a foreign Origin', async () => {
    const { a, deps, routes } = await boot();
    const s = await login(a, deps);
    const writers = routes.filter((r) => !r.public && !['GET', 'HEAD'].includes(r.method));
    expect(writers.length).toBeGreaterThan(10);
    // The new state-changing routes are really in the set that is swept (the sweep is not vacuous for them).
    const writerKeys = writers.map((r) => `${r.method} ${r.url}`);
    for (const must of [
      'POST /api/captures/:id/answer', 'POST /api/captures/:id/ask', 'POST /api/projects', 'PATCH /api/projects/:id', 'DELETE /api/projects/:id', 'PUT /api/projects/:id/people/:personId',
      'DELETE /api/projects/:id/people/:personId', 'PUT /api/nav/pins/:kind/:id', 'DELETE /api/nav/pins/:kind/:id', 'POST /api/nav/recents',
    ]) expect(writerKeys).toContain(must);
    for (const r of writers) {
      const url = fill(r.url);
      const noCsrf = await a.inject({ method: r.method as 'POST', url, headers: { cookie: s.cookie, origin: TEST_ORIGIN } });
      expect(noCsrf.statusCode, `${r.method} ${url} without CSRF`).toBe(403);
      const wrong = await a.inject({ method: r.method as 'POST', url, headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': `${s.csrf}x` } });
      expect(wrong.statusCode, `${r.method} ${url} wrong CSRF`).toBe(403);
      const foreign = await a.inject({ method: r.method as 'POST', url, headers: { cookie: s.cookie, origin: 'https://evil.example', 'x-xo-csrf': s.csrf } });
      expect(foreign.statusCode, `${r.method} ${url} foreign origin`).toBe(403);
      const noOrigin = await a.inject({ method: r.method as 'POST', url, headers: { cookie: s.cookie, 'x-xo-csrf': s.csrf } });
      expect(noOrigin.statusCode, `${r.method} ${url} no origin`).toBe(403);
    }
    // And nothing was written by any of those refused requests.
    expect((await authed(a, s, 'GET', '/api/people')).json()).toEqual({ people: [] });
    expect((await authed(a, s, 'GET', '/api/projects')).json()).toEqual({ projects: [] });
    expect((await authed(a, s, 'GET', '/api/nav')).json()).toEqual({ pinned: [], recents: [] });
  });

  it('with a session, the new project and nav writes work with the CSRF header (paired with the refusals above)', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const made = await authed(a, s, 'POST', '/api/projects', { title: 'Csrf project' });
    expect(made.statusCode).toBe(201);
    const id = (made.json() as Project).id;
    const person = (await authed(a, s, 'POST', '/api/people', { name: 'Csrf Anna' })).json() as { id: number };
    expect((await authed(a, s, 'PATCH', `/api/projects/${id}`, { status: 'on_hold' })).statusCode).toBe(200);
    expect((await authed(a, s, 'PUT', `/api/projects/${id}/people/${person.id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'PUT', `/api/nav/pins/project/${id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'POST', '/api/nav/recents', { kind: 'project', id })).statusCode).toBe(204);
    const nav = (await authed(a, s, 'GET', '/api/nav')).json() as NavResponse;
    expect(nav.pinned.map((n) => n.title)).toEqual(['Csrf project']);
    expect(nav.recents.map((n) => n.title)).toEqual(['Csrf project']);
    expect((await authed(a, s, 'DELETE', `/api/nav/pins/project/${id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'DELETE', `/api/projects/${id}/people/${person.id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'DELETE', `/api/projects/${id}`)).statusCode).toBe(204);
  });

  it('GET needs no CSRF header; a good POST works; Host and X-Forwarded-Host never stand in for Origin', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    expect((await a.inject({ method: 'GET', url: '/api/people', headers: { cookie: s.cookie } })).statusCode).toBe(200);
    const spoof = await a.inject({
      method: 'POST', url: '/api/people', payload: { name: 'Anna' },
      headers: { cookie: s.cookie, 'x-xo-csrf': s.csrf, host: 'localhost:5173', 'x-forwarded-host': 'localhost:5173' },
    });
    expect(spoof.statusCode).toBe(403);
    expect((await authed(a, s, 'POST', '/api/people', { name: 'Anna' })).statusCode).toBe(201);
  });

  it('logout kills the session and the old CSRF token', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    expect((await authed(a, s, 'POST', '/api/auth/logout')).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    expect((await authed(a, s, 'POST', '/api/people', { name: 'Anna' })).statusCode).toBe(401);
  });
});

describe('login and session cookie', () => {
  it('production-style config: __Host- cookie with HttpOnly, Secure, SameSite=Strict, Path=/ and no Domain', async () => {
    const origin = 'https://xo.example.ts.net';
    const config = makeTestConfig({ XO_COOKIE_INSECURE: 'false', XO_PUBLIC_ORIGIN: origin });
    const { a, deps } = await boot({ config });
    const res = await a.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin }, payload: { password: PASSWORD, totp: totpAt(SECRET, deps.now()) },
    });
    expect(res.statusCode).toBe(200);
    const raw = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
    const session = raw.find((c) => c.startsWith('__Host-xo_session='));
    expect(session, raw.join('\n')).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('Secure');
    expect(session).toContain('SameSite=Strict');
    expect(session).toMatch(/; Path=\/(;|$)/); // exactly "/", not "/api"
    expect(session).toContain('Max-Age=2592000'); // 30 days
    expect(session).not.toMatch(/Domain=/i);
    const device = raw.find((c) => c.startsWith('__Host-xo_device='));
    expect(device, raw.join('\n')).toBeDefined();
    expect(device).toMatch(/; Path=\/(;|$)/);
    expect(device).toContain('Max-Age=31536000'); // 365 days
    for (const c of raw) {
      expect(c).toMatch(/^__Host-/);
      expect(c).toContain('Secure');
      expect(c).toContain('HttpOnly');
    }
    // The CSRF token travels in the body, never in a cookie.
    expect(raw.join('\n')).not.toContain((res.json() as { csrfToken: string }).csrfToken);
  });

  it('dev config (XO_COOKIE_INSECURE): xo_session, HttpOnly, SameSite=Strict, no Secure', async () => {
    const { a, deps } = await boot();
    const res = await a.inject({
      method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload: { password: PASSWORD, totp: totpAt(SECRET, deps.now()) },
    });
    const raw = String(([] as string[]).concat(res.headers['set-cookie'] as string | string[]).find((c) => c.startsWith('xo_session=')));
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).not.toContain('Secure');
  });

  it('wrong password, wrong code, reused code and an unconfigured server all give the same 401 body', async () => {
    const good = await boot();
    const code = totpAt(SECRET, good.deps.now());
    const bad = (a: FastifyInstance, payload: object) => a.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: TEST_ORIGIN }, payload });
    const wrongPassword = await bad(good.a, { password: 'wrong horse battery', totp: code });
    const wrongCode = await bad(good.a, { password: PASSWORD, totp: '000000' });
    // setupUser confirmed with the previous step, so `code` (current step) works once, then is a replay.
    const first = await bad(good.a, { password: PASSWORD, totp: code });
    const replay = await bad(good.a, { password: PASSWORD, totp: code });
    expect(first.statusCode).toBe(200);
    await good.a.close();

    const empty = makeDeps(); // no user row at all
    app = await buildApp(empty);
    const noUser = await bad(app, { password: PASSWORD, totp: code });

    const bodies = [wrongPassword, wrongCode, replay, noUser].map((r) => {
      expect(r.statusCode).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
      return r.body;
    });
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: 'invalid_credentials', message: 'Invalid credentials' } });
  });

  it('repeated failures from one address are rate limited with Retry-After, and a lockout also refuses the right password', async () => {
    const { a, deps } = await boot();
    const attempt = () => a.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', headers: { origin: TEST_ORIGIN },
      payload: { password: 'wrong horse battery', totp: '000000' },
    });
    for (let i = 0; i < 5; i++) expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const right = await a.inject({
      method: 'POST', url: '/api/auth/login', remoteAddress: '203.0.113.7', headers: { origin: TEST_ORIGIN },
      payload: { password: PASSWORD, totp: totpAt(SECRET, deps.now()) },
    });
    expect(right.statusCode).toBe(429);
  });
});

describe('capture -> file -> undo round trip (real DB, fake classifier)', () => {
  it('prefix capture files an action without the classifier, undo removes it, undo twice is 409', async () => {
    const calls: string[] = [];
    const classifier = { classify: async (i: { text: string }) => { calls.push(i.text); throw new Error('must not be called'); } };
    const { a, deps } = await boot({ classifier });
    const s = await login(a, deps);

    const made = await authed(a, s, 'POST', '/api/captures', { text: '/todo call the bank', source: 'text' });
    expect(made.statusCode).toBe(201);
    const cap = made.json() as Capture;
    expect(cap.status).toBe('filed');
    expect(cap.summary).toContain('call the bank');
    expect(cap.classifiedBy).toBe('prefix');
    expect(calls).toEqual([]);

    const open = (await authed(a, s, 'GET', '/api/actions?status=open')).json() as { actions: Action[] };
    expect(open.actions.map((x) => x.text)).toEqual(['call the bank']);
    expect(open.actions[0]!.owner).toBe('me');

    const undone = await authed(a, s, 'POST', `/api/captures/${cap.id}/undo`);
    expect(undone.statusCode).toBe(200);
    expect((undone.json() as Capture).status).toBe('undone');
    expect(((await authed(a, s, 'GET', '/api/actions?status=open')).json() as { actions: Action[] }).actions).toEqual([]);
    expect((await authed(a, s, 'POST', `/api/captures/${cap.id}/undo`)).statusCode).toBe(409);
  });

  it('LLM path: confident -> filed as note; unsure or failing -> nothing filed until the user answers', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const notes = async () => ((await authed(a, s, 'GET', '/api/notes')).json() as { notes: Note[] }).notes;

    const confident = (await authed(a, s, 'POST', '/api/captures', { text: 'remember the board deck', source: 'text' })).json() as Capture;
    expect(confident).toMatchObject({ status: 'filed', classifiedBy: 'llm' });
    expect(await notes()).toHaveLength(1);

    for (const text of ['maybe this?? thing', 'anything !!fail']) {
      const pending = (await authed(a, s, 'POST', '/api/captures', { text, source: 'text' })).json() as Capture;
      expect(pending.status).toBe('pending');
      expect(pending.question?.type).toBe('kind');
      expect(await notes()).toHaveLength(1); // nothing written yet
    }
    const list = (await authed(a, s, 'GET', '/api/captures?limit=10')).json() as { captures: Capture[] };
    const unsure = list.captures.find((c) => c.text === 'maybe this?? thing')!;
    const answered = (await authed(a, s, 'POST', `/api/captures/${unsure.id}/answer`, { key: 'n' })).json() as Capture;
    expect(answered).toMatchObject({ status: 'filed', classifiedBy: 'user' });
    expect(await notes()).toHaveLength(2);
    expect((await authed(a, s, 'POST', `/api/captures/${unsure.id}/answer`, { key: 'n' })).statusCode).toBe(409);
  });

  it('no classifier configured (no API key): every unprefixed capture asks for the kind', async () => {
    const { a, deps } = await boot({ classifier: null });
    const s = await login(a, deps);
    const cap = (await authed(a, s, 'POST', '/api/captures', { text: 'plain thought', source: 'text' })).json() as Capture;
    expect(cap.status).toBe('pending');
    expect(cap.question?.type).toBe('kind');
    expect((await authed(a, s, 'POST', '/api/captures', { text: '/note typed anyway', source: 'text' })).statusCode).toBe(201);
  });

  it('a person named by @mention: unknown asks, known (also non-ASCII) links', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const unknown = (await authed(a, s, 'POST', '/api/captures', { text: '/note lunch with @Bob', source: 'text' })).json() as Capture;
    expect(unknown.question?.type).toBe('unknown_person');
    await authed(a, s, 'POST', '/api/people', { name: 'Åsa Lind', aliases: ['Asa'] });
    const known = (await authed(a, s, 'POST', '/api/captures', { text: '/agenda @åsa hiring plan', source: 'text' })).json() as Capture;
    expect(known.status).toBe('filed');
    expect(known.draft.personName ?? known.summary).toContain('Åsa');
  });

  it('input validation: unknown fields, wrong types and over-long text are 400', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    for (const payload of [{ text: 'x', source: 'text', extra: 1 }, { text: 5, source: 'text' }, { text: 'x', source: 'carrier pigeon' }, { text: 'x'.repeat(10_001), source: 'text' }]) {
      expect((await authed(a, s, 'POST', '/api/captures', payload)).statusCode).toBe(400);
    }
    expect((await authed(a, s, 'POST', '/api/search', { q: "'; DROP TABLE people; --" })).statusCode).toBe(200);
    expect((await authed(a, s, 'GET', '/api/people')).statusCode).toBe(200);
  });
});

describe('OpenRouter wiring through the whole app (fake fetch)', () => {
  interface Call { url: string; body: Record<string, unknown>; auth: string | null }
  function fakeFetch(opts: { fail?: boolean } = {}) {
    const calls: Call[] = [];
    const f = (async (url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: headers.get('authorization') });
      if (opts.fail) return new Response(`upstream says: ${API_KEY} and the capture text`, { status: 500 });
      if (String(url).endsWith('/audio/transcriptions')) return new Response(JSON.stringify({ text: 'open Anna' }), { status: 200 });
      const content = JSON.stringify({ kind: 'note', confidence: 0.95, personName: null, projectName: null, owner: 'me' });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;
    return { f, calls };
  }

  for (const [zdr, env] of [[true, 'true'], [false, 'false'], [false, undefined]] as const) {
    it(`XO_OPENROUTER_ZDR=${env}: chat and transcription requests ${zdr ? 'carry a forced provider.zdr' : 'send no zdr'}; the key only goes in the auth header`, async () => {
      const { f, calls } = fakeFetch();
      const config = makeTestConfig({ XO_LLM: 'openrouter', ...(env === undefined ? {} : { XO_OPENROUTER_ZDR: env }) });
      const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
      const s = await login(a, deps);

      const cap = await authed(a, s, 'POST', '/api/captures', { text: 'remember the board deck', source: 'text' });
      expect(cap.statusCode).toBe(201);
      expect((cap.json() as Capture).classifiedBy).toBe('llm');
      const voice = await a.inject({
        method: 'POST', url: '/api/voice/transcribe', payload: Buffer.from('RIFFxxxx'),
        headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': s.csrf, 'content-type': 'audio/wav' },
      });
      expect(voice.json()).toEqual({ text: 'open Anna' });

      expect(calls.map((c) => c.url)).toEqual([
        'https://openrouter.ai/api/v1/chat/completions',
        'https://openrouter.ai/api/v1/audio/transcriptions',
      ]);
      for (const c of calls) {
        expect(c.auth).toBe(`Bearer ${API_KEY}`);
        const provider = (c.body['provider'] ?? {}) as Record<string, unknown>;
        if (zdr) expect(provider['zdr']).toBe(true);
        else expect(provider).not.toHaveProperty('zdr');
        expect(JSON.stringify(c.body)).not.toContain(API_KEY);
      }
      // Nothing that reached the browser contains the key either.
      for (const body of [cap.body, voice.body]) expect(body).not.toContain(API_KEY);
      expect(JSON.stringify(deps.config)).not.toContain(API_KEY);
    });
  }

  it('upstream failures: classification falls back to asking, transcription is a generic 502; no key, no upstream text in any response', async () => {
    const { f, calls } = fakeFetch({ fail: true });
    const config = makeTestConfig({ XO_LLM: 'openrouter', XO_OPENROUTER_ZDR: 'true' });
    const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
    const s = await login(a, deps);

    const cap = await authed(a, s, 'POST', '/api/captures', { text: 'a secret board thought', source: 'text' });
    expect((cap.json() as Capture).status).toBe('pending');
    expect(((await authed(a, s, 'GET', '/api/notes')).json() as { notes: Note[] }).notes).toEqual([]);
    const voice = await a.inject({
      method: 'POST', url: '/api/voice/transcribe', payload: Buffer.from('RIFFxxxx'),
      headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': s.csrf, 'content-type': 'audio/wav' },
    });
    expect(voice.statusCode).toBe(502);
    expect(voice.json()).toEqual({ error: { code: 'upstream_error', message: 'Transcription failed' } });
    // The failing requests really happened (so the "absent" checks below mean something) ...
    expect(calls).toHaveLength(2);
    // ... and no ZDR request was retried without ZDR.
    for (const c of calls) expect((c.body['provider'] as Record<string, unknown>)['zdr']).toBe(true);
    for (const body of [cap.body, voice.body]) {
      expect(body).not.toContain(API_KEY);
      expect(body).not.toContain('upstream says');
    }
    expect(voice.body).not.toContain('board');
  });

  it('without an API key and XO_LLM=openrouter, voice is 503 and classification asks', async () => {
    const config = makeTestConfig({ XO_LLM: 'openrouter' });
    const { a, deps } = await boot({ config, ...pickLlm(config, null) });
    const s = await login(a, deps);
    const voice = await a.inject({
      method: 'POST', url: '/api/voice/transcribe', payload: Buffer.from('RIFFxxxx'),
      headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': s.csrf, 'content-type': 'audio/wav' },
    });
    expect(voice.statusCode).toBe(503);
    const cap = (await authed(a, s, 'POST', '/api/captures', { text: 'hello', source: 'text' })).json() as Capture;
    expect(cap.status).toBe('pending');
  });
});

describe('response headers and error hygiene', () => {
  it('API responses are no-store; the CSP, referrer and permissions policies are set', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    for (const res of [await a.inject({ method: 'GET', url: '/api/health' }), await authed(a, s, 'GET', '/api/people')]) {
      expect(res.headers['cache-control']).toBe('no-store');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain('unsafe-inline');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(String(res.headers['permissions-policy'])).toContain('microphone=(self)');
    }
  });

  it('error bodies use one shape, never echo SQL, stack traces or internal details', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const responses = [
      await authed(a, s, 'GET', '/api/people/999999'),
      await authed(a, s, 'GET', '/api/people/abc'),
      await authed(a, s, 'POST', '/api/notes', { bodyMd: 5 }),
      await authed(a, s, 'POST', '/api/meetings/999999/end'),
      await a.inject({ method: 'POST', url: '/api/notes', headers: { cookie: s.cookie, origin: TEST_ORIGIN, 'x-xo-csrf': s.csrf, 'content-type': 'application/json' }, payload: '{bad' }),
    ];
    for (const r of responses) {
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.statusCode).toBeLessThan(500);
      const body = r.json() as { error: { code: string; message: string } };
      expect(Object.keys(body)).toEqual(['error']);
      expect(typeof body.error.code).toBe('string');
      expect(r.body).not.toMatch(/SQLITE|node:|\.ts:|at \w+ \(|stack/i);
    }
  });
});

describe('the 1-1 loop over HTTP', () => {
  it('agenda -> meeting -> check off -> follow-ups -> notes -> end -> next meeting carries over', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const anna = (await authed(a, s, 'POST', '/api/people', { name: 'Anna' })).json() as { id: number };
    for (const text of ['hiring plan', 'budget', 'offsite']) {
      expect((await authed(a, s, 'POST', `/api/people/${anna.id}/agenda`, { text })).statusCode).toBe(201);
    }
    const m1 = (await authed(a, s, 'POST', `/api/people/${anna.id}/meetings`)).json() as { meeting: { id: number }; openAgenda: { id: number; text: string }[] };
    expect(m1.openAgenda.map((i) => i.text)).toEqual(['hiring plan', 'budget', 'offsite']);
    const first = m1.openAgenda[0]!;
    expect((await authed(a, s, 'PATCH', `/api/agenda/${first.id}`, { status: 'done', meetingId: m1.meeting.id })).statusCode).toBe(200);
    await authed(a, s, 'POST', '/api/actions', { text: 'send offer', owner: 'me', personId: anna.id, meetingId: m1.meeting.id });
    await authed(a, s, 'POST', '/api/actions', { text: 'draft brief', owner: 'them', personId: anna.id, meetingId: m1.meeting.id });
    expect((await authed(a, s, 'PATCH', `/api/meetings/${m1.meeting.id}`, { notesMd: 'Discussed hiring.' })).statusCode).toBe(200);
    expect((await authed(a, s, 'POST', `/api/meetings/${m1.meeting.id}/end`)).statusCode).toBe(200);
    expect((await authed(a, s, 'POST', `/api/meetings/${m1.meeting.id}/end`)).statusCode).toBe(200); // idempotent

    const m2 = (await authed(a, s, 'POST', `/api/people/${anna.id}/meetings`)).json() as {
      meeting: { id: number };
      openAgenda: { text: string }[];
      previous: { meeting: { notesMd: string }; resolved: { text: string }[]; actions: { text: string; owner: string }[] } | null;
    };
    expect(m2.meeting.id).not.toBe(m1.meeting.id);
    expect(m2.openAgenda.map((i) => i.text)).toEqual(['budget', 'offsite']);
    expect(m2.previous?.meeting.notesMd).toBe('Discussed hiring.');
    expect(m2.previous?.resolved.map((i) => i.text)).toEqual(['hiring plan']);
    expect(m2.previous?.actions.map((x) => `${x.owner}:${x.text}`).sort()).toEqual(['me:send offer', 'them:draft brief']);
  });
});

describe('projects through the whole app', () => {
  const capture = async (a: FastifyInstance, s: Session, text: string): Promise<Capture> => {
    const res = await authed(a, s, 'POST', '/api/captures', { text, source: 'text' });
    expect(res.statusCode, text).toBe(201);
    return res.json() as Capture;
  };
  const actions = async (a: FastifyInstance, s: Session, query = ''): Promise<Action[]> =>
    ((await authed(a, s, 'GET', `/api/actions?status=open${query}`)).json() as { actions: Action[] }).actions;

  it('#project forces the link with no classifier call; unknown and suggested projects ask first; undo keeps a created project', async () => {
    const calls: string[] = [];
    const spy = { classify: async (i: { text: string }) => { calls.push(i.text); return { kind: 'action' as const, confidence: 0.95, personName: null, projectName: 'Apollo', owner: 'me' as const }; } };
    const { a, deps } = await boot({ classifier: spy });
    const s = await login(a, deps);
    const apollo = (await authed(a, s, 'POST', '/api/projects', { title: 'Apollo' })).json() as Project;

    // Explicit #mention: filed into the project, the classifier is never asked.
    const forced = await capture(a, s, '/todo #apollo fix slides');
    expect(forced).toMatchObject({ status: 'filed', classifiedBy: 'prefix' });
    expect(forced.draft.projectId).toBe(apollo.id);
    expect(calls).toEqual([]);
    const mine = await actions(a, s, `&projectId=${apollo.id}`);
    expect(mine.map((x) => x.text)).toEqual(['apollo fix slides']);
    expect(mine[0]!.projectId).toBe(apollo.id);
    expect(await actions(a, s, '&projectId=none')).toEqual([]);
    const detail = (await authed(a, s, 'GET', `/api/projects/${apollo.id}`)).json() as ProjectDetailResponse;
    expect(detail.openActions.map((x) => x.text)).toEqual(['apollo fix slides']);

    // Unknown #name: asks, files nothing and creates nothing until answered; 'c' creates and files, undo keeps the project.
    const unknown = await capture(a, s, '/todo #zeta call the bank');
    expect(unknown.status).toBe('pending');
    expect(unknown.question).toMatchObject({ type: 'unknown_project', name: 'zeta' });
    expect((await authed(a, s, 'GET', '/api/projects')).json() as ProjectsListResponse).toMatchObject({ projects: [{ title: 'Apollo' }] });
    const created = (await authed(a, s, 'POST', `/api/captures/${unknown.id}/answer`, { key: 'c' })).json() as Capture;
    expect(created.status).toBe('filed');
    const titles = async () => ((await authed(a, s, 'GET', '/api/projects')).json() as ProjectsListResponse).projects.map((p) => p.title).sort();
    expect(await titles()).toEqual(['Apollo', 'zeta']);
    expect((await authed(a, s, 'POST', `/api/captures/${unknown.id}/undo`)).statusCode).toBe(200);
    expect(await titles()).toEqual(['Apollo', 'zeta']);
    expect((await actions(a, s)).map((x) => x.text)).toEqual(['apollo fix slides']);

    // A classifier's project name is only a suggestion: it asks, and files only after the answer.
    const suggested = await capture(a, s, 'remember the launch');
    expect(calls).toEqual(['remember the launch']);
    expect(suggested.status).toBe('pending');
    expect(suggested.question).toMatchObject({ type: 'ambiguous_project' });
    expect(await actions(a, s, `&projectId=${apollo.id}`)).toHaveLength(1); // still just the first one
    // An answer naming a project that does not exist is refused and files nothing.
    const bogus = await authed(a, s, 'POST', `/api/captures/${suggested.id}/answer`, { projectId: 999999 });
    expect(bogus.statusCode).toBe(400);
    const stillPending = ((await authed(a, s, 'GET', '/api/captures?limit=10')).json() as { captures: Capture[] }).captures.find((c) => c.id === suggested.id)!;
    expect(stillPending.status).toBe('pending');
    expect(await actions(a, s, `&projectId=${apollo.id}`)).toHaveLength(1);
    const key = (suggested.question as { candidates: { key: string; projectId: number }[] }).candidates.find((c) => c.projectId === apollo.id)!.key;
    const filed = (await authed(a, s, 'POST', `/api/captures/${suggested.id}/answer`, { key })).json() as Capture;
    expect(filed).toMatchObject({ status: 'filed', classifiedBy: 'llm' }); // the kind is still the classifier's
    expect(filed.draft.projectId).toBe(apollo.id);
    expect(await actions(a, s, `&projectId=${apollo.id}`)).toHaveLength(2);
  });

  it('a project deleted before the answer files without it, and an unknown project id is refused', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    const gone = (await authed(a, s, 'POST', '/api/projects', { title: 'Gone' })).json() as Project;
    const cap = await capture(a, s, 'todo: slides for project Gone');
    expect(cap.question).toMatchObject({ type: 'ambiguous_project' });
    expect((await authed(a, s, 'DELETE', `/api/projects/${gone.id}`)).statusCode).toBe(204);
    const stale = await authed(a, s, 'POST', `/api/captures/${cap.id}/answer`, { projectId: gone.id });
    expect(stale.statusCode).toBe(400) // the project is gone: refused, nothing filed by it;
    expect((await authed(a, s, 'POST', '/api/actions', { text: 'x', projectId: gone.id })).statusCode).toBe(400);
    expect((await authed(a, s, 'POST', '/api/actions', { text: 'x', projectId: 999999 })).statusCode).toBe(400);
    const left = (await authed(a, s, 'GET', '/api/captures?limit=10')).json() as { captures: Capture[] };
    const again = left.captures.find((c) => c.id === cap.id)!;
    expect(again.question).toBeNull(); // the only candidate is gone: nothing left to ask (the client shows "Ready to file")
    expect(again.draft.projectId).toBeNull();
    expect(again.status).toBe('pending');
    const done = (await authed(a, s, 'POST', `/api/captures/${cap.id}/answer`, { key: 's' })).json() as Capture;
    expect(done.status).toBe('filed');
    expect(done.draft.projectId).toBeNull();
    expect((await actions(a, s)).every((x) => x.projectId === null)).toBe(true);
  });

  it('a deleted project is invisible on every read path at once, and after the purge no table holds its title, alias or description', async () => {
    // The classifier suggests the project by its title; the typed text does not contain it.
    const suggest = { classify: async () => ({ kind: 'note' as const, confidence: 0.95, personName: null, projectName: 'ERASEME-Title', owner: 'me' as const }) };
    const { a, deps } = await boot({ classifier: suggest });
    const s = await login(a, deps);
    const TITLE1 = 'ERASEME-Title';
    const TITLE2 = 'ERASEME-Other';
    const ALIAS = 'ERASEME-Alias';
    const DESC = 'ERASEME-Description with Åre';
    const p1 = (await authed(a, s, 'POST', '/api/projects', { title: TITLE1, aliases: [ALIAS], descriptionMd: DESC })).json() as Project;
    const p2 = (await authed(a, s, 'POST', '/api/projects', { title: TITLE2 })).json() as Project;
    const anna = (await authed(a, s, 'POST', '/api/people', { name: 'Erase Anna' })).json() as { id: number };
    expect((await authed(a, s, 'PUT', `/api/projects/${p1.id}/people/${anna.id}`)).statusCode).toBe(204);
    const action = (await authed(a, s, 'POST', '/api/actions', { text: 'kept action', projectId: p1.id })).json() as Action;
    const note = (await authed(a, s, 'POST', '/api/notes', { bodyMd: 'kept note body', projectId: p1.id })).json() as Note;
    expect((await authed(a, s, 'PUT', `/api/nav/pins/project/${p1.id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'POST', '/api/nav/recents', { kind: 'project', id: p1.id })).statusCode).toBe(204);
    // A pending capture whose project question lists both projects as candidates (the typed text does not contain the titles).
    const asking = await capture(a, s, '/todo #eraseme write it up');
    expect(asking.question).toMatchObject({ type: 'ambiguous_project' });
    expect((asking.question as { candidates: unknown[] }).candidates).toHaveLength(2);

    const suggested = await capture(a, s, 'remember the quarterly thing');
    expect(suggested.status).toBe('pending');
    expect(suggested.question).toMatchObject({ type: 'ambiguous_project' });
    expect(suggested.text).not.toContain('ERASEME');
    const capturesOnly = (): string => JSON.stringify(deps.db.prepare('SELECT * FROM captures').all());
    // The captures rows alone hold both titles (candidate lists and the suggestion), so the scrub has something to remove.
    for (const needle of [TITLE1, TITLE2]) expect(capturesOnly(), `captures hold ${needle}`).toContain(needle);

    const everything = (): string => {
      const tables = deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as { name: string }[];
      return tables.map((t) => JSON.stringify(deps.db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');
    };
    const search = async (q: string) => ((await authed(a, s, 'POST', '/api/search', { q })).json() as { results: { kind: string; id: number }[] }).results;

    // Before: the project is everywhere it should be (so the absence checks below mean something).
    for (const needle of [TITLE1, TITLE2, ALIAS, 'ERASEME-Description']) expect(everything(), needle).toContain(needle);
    expect((await search(TITLE1)).some((r) => r.kind === 'project' && r.id === p1.id)).toBe(true);
    expect(((await authed(a, s, 'GET', '/api/nav')).json() as NavResponse).pinned.map((n: NavItem) => n.id)).toEqual([p1.id]);
    expect((await authed(a, s, 'GET', `/api/projects/${p1.id}`)).statusCode).toBe(200);

    expect((await authed(a, s, 'DELETE', `/api/projects/${p1.id}`)).statusCode).toBe(204);
    expect((await authed(a, s, 'DELETE', `/api/projects/${p2.id}`)).statusCode).toBe(204);

    // At once: gone from every read path, the items it held are kept without a project.
    expect((await authed(a, s, 'GET', '/api/projects')).json()).toEqual({ projects: [] });
    expect((await authed(a, s, 'GET', `/api/projects/${p1.id}`)).statusCode).toBe(404);
    expect((await authed(a, s, 'GET', '/api/nav')).json()).toEqual({ pinned: [], recents: [] });
    for (const q of [TITLE1, ALIAS, 'ERASEME-Description', 'åre']) {
      expect((await search(q)).filter((r) => r.kind === 'project'), q).toEqual([]);
    }
    expect((await actions(a, s)).find((x) => x.id === action.id)?.projectId).toBeNull();
    expect(((await authed(a, s, 'GET', `/api/notes/${note.id}`)).json() as Note).projectId).toBeNull();
    const pending = ((await authed(a, s, 'GET', '/api/captures?limit=10')).json() as { captures: Capture[] }).captures.find((c) => c.id === asking.id)!;
    expect(JSON.stringify(pending)).not.toContain('ERASEME-');
    const sugg = ((await authed(a, s, 'GET', '/api/captures?limit=10')).json() as { captures: Capture[] }).captures.find((c) => c.id === suggested.id)!;
    expect(JSON.stringify(sugg)).not.toContain('ERASEME-');
    for (const needle of [TITLE1, TITLE2]) expect(capturesOnly(), `captures after delete: ${needle}`).not.toContain(needle);

    // After the purge: no table holds any of the strings.
    expect(purgeDeleted(deps.db, new Date(FIXED_NOW.getTime() + 31 * 86_400_000))).toMatchObject({ projects: 2 });
    for (const needle of [TITLE1, TITLE2, ALIAS, 'ERASEME-Description']) expect(everything(), needle).not.toContain(needle);
    expect(everything()).toContain('kept action'); // the scan reads real data; the items themselves stay
  });
});

describe('question answering through the whole app (fake fetch behind the real OpenRouter client)', () => {
  const NOTE = 'QA-NOTE-Anna asked for the revised budget by Friday';
  interface Call { url: string; body: Record<string, any> }
  function qaFetch(opts: { fail?: boolean; cite?: string[] } = {}) {
    const calls: Call[] = [];
    const f = (async (url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      calls.push({ url: String(url), body });
      if (opts.fail) return new Response(`upstream says: ${API_KEY} ${NOTE}`, { status: 500 });
      const user = JSON.parse(body['messages'].at(-1).content) as { excerpts: { ref: string }[] };
      const content = JSON.stringify({ answer: 'Anna wants the budget by Friday.', cited: opts.cite ?? user.excerpts.map((e) => e.ref) });
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200 });
    }) as typeof fetch;
    return { f, calls };
  }
  const seed = async (a: FastifyInstance, s: Session) => {
    const person = (await authed(a, s, 'POST', '/api/people', { name: 'Anna Berg' })).json() as { id: number };
    const note = (await authed(a, s, 'POST', '/api/notes', { title: 'Budget', bodyMd: NOTE, personId: person.id })).json() as Note;
    return { person, note };
  };
  const captures = async (a: FastifyInstance, s: Session) =>
    ((await authed(a, s, 'GET', '/api/captures?limit=20')).json() as { captures: Capture[] }).captures;

  for (const [zdr, env] of [[true, 'true'], [false, 'false']] as const) {
    it(`XO_OPENROUTER_ZDR=${env}: only capped excerpts are sent as JSON, ${zdr ? 'zdr forced' : 'no zdr'}, no plugins or tools; the answer is stored and listed`, async () => {
      const { f, calls } = qaFetch();
      const config = makeTestConfig({ XO_LLM: 'openrouter', XO_OPENROUTER_ZDR: env, XO_QA_MODEL: 'anthropic/claude-sonnet-5.5' });
      const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
      const s = await login(a, deps);
      const { note } = await seed(a, s);
      for (let i = 0; i < 30; i++) await authed(a, s, 'POST', '/api/notes', { bodyMd: `budget filler ${i} ${'x '.repeat(500)}` });

      const asked = (await authed(a, s, 'POST', '/api/captures', { text: '/ask what does Anna want for the budget?', source: 'text' })).json() as Capture;
      expect(asked).toMatchObject({ status: 'asked', answer: null });
      expect(calls).toHaveLength(0); // storing the question sends nothing anywhere
      const res = await authed(a, s, 'POST', `/api/captures/${asked.id}/ask`);
      expect(res.statusCode).toBe(200);
      const got = res.json() as Capture;
      expect(got).toMatchObject({ status: 'answered', answer: { text: 'Anna wants the budget by Friday.', redacted: false } });
      expect(got.answer!.sources).toContainEqual({ kind: 'note', id: note.id, title: 'Budget' });

      expect(calls.map((c) => c.url)).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
      const b = calls[0]!.body;
      expect(b['model']).toBe('anthropic/claude-sonnet-5.5');
      expect(b['provider']['require_parameters']).toBe(true);
      if (zdr) expect(b['provider']['zdr']).toBe(true); else expect(b['provider']).not.toHaveProperty('zdr');
      expect(b).not.toHaveProperty('plugins');
      expect(b).not.toHaveProperty('tools');
      const sent = JSON.parse(b['messages'].at(-1).content) as { question: string; excerpts: { ref: string; title: string; text: string }[] };
      expect(sent.question).toBe('what does Anna want for the budget?');
      expect(sent.excerpts.length).toBeGreaterThan(0);
      expect(sent.excerpts.length).toBeLessThanOrEqual(24);
      expect(sent.excerpts.every((e) => e.text.length <= 600)).toBe(true);
      expect(sent.excerpts.reduce((n, e) => n + e.title.length + e.text.length, 0)).toBeLessThanOrEqual(12_000);
      expect(sent.excerpts.some((e) => e.ref === `note:${note.id}`)).toBe(true);
      expect(JSON.stringify(b)).not.toContain(API_KEY);
      expect(res.body).not.toContain(API_KEY);
      expect((await captures(a, s)).find((c) => c.id === asked.id)).toMatchObject({ status: 'answered' });
    });
  }

  it('nothing matches: the fixed answer and no request to OpenRouter', async () => {
    const { f, calls } = qaFetch();
    const config = makeTestConfig({ XO_LLM: 'openrouter' });
    const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
    const s = await login(a, deps);
    await seed(a, s);
    const asked = (await authed(a, s, 'POST', '/api/captures', { text: '/ask what is the weather in Lisbon?', source: 'text' })).json() as Capture;
    const res = (await authed(a, s, 'POST', `/api/captures/${asked.id}/ask`)).json() as Capture;
    expect(res.answer).toEqual({ text: 'Nothing in your data matches that.', sources: [], redacted: false });
    expect(calls).toHaveLength(0);
  });

  it('an upstream failure is a generic 502: no key, no upstream text, no data in the response; the question stays asked', async () => {
    const { f, calls } = qaFetch({ fail: true });
    const config = makeTestConfig({ XO_LLM: 'openrouter', XO_OPENROUTER_ZDR: 'true' });
    const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
    const s = await login(a, deps);
    await seed(a, s);
    const asked = (await authed(a, s, 'POST', '/api/captures', { text: '/ask what does Anna want for the budget?', source: 'text' })).json() as Capture;
    const res = await authed(a, s, 'POST', `/api/captures/${asked.id}/ask`);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: 'llm_failed', message: 'Could not get an answer' } });
    expect(calls).toHaveLength(1); // the failing call really happened, so the checks below mean something
    expect(calls[0]!.body['provider']['zdr']).toBe(true); // no retry without zdr
    for (const leak of [API_KEY, 'upstream says', 'QA-NOTE']) expect(res.body).not.toContain(leak);
    expect((await captures(a, s)).find((c) => c.id === asked.id)).toMatchObject({ status: 'asked', answer: null });
  });

  it('without an API key the endpoint is 503 no_llm and the question waits', async () => {
    const config = makeTestConfig({ XO_LLM: 'openrouter' });
    const { a, deps } = await boot({ config, ...pickLlm(config, null) });
    const s = await login(a, deps);
    const asked = (await authed(a, s, 'POST', '/api/captures', { text: '/ask anything?', source: 'text' })).json() as Capture;
    expect(asked.status).toBe('asked');
    const res = await authed(a, s, 'POST', `/api/captures/${asked.id}/ask`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('no_llm');
  });

  it('deleting a used note blanks the answer on the next read; the purge erases it from every table', async () => {
    const { f } = qaFetch({ cite: [] });
    const config = makeTestConfig({ XO_LLM: 'openrouter' });
    const { a, deps } = await boot({ config, ...pickLlm(config, API_KEY, f) });
    const s = await login(a, deps);
    const { note } = await seed(a, s);
    const asked = (await authed(a, s, 'POST', '/api/captures', { text: '/ask what does Anna want for the budget?', source: 'text' })).json() as Capture;
    await authed(a, s, 'POST', `/api/captures/${asked.id}/ask`);
    const everything = (): string => {
      const out: string[] = [];
      for (const { name } of deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]) {
        if (name === 'user' || name === 'sessions') continue;
        out.push(JSON.stringify(deps.db.prepare(`SELECT * FROM ${name}`).all()));
      }
      return out.join('\n');
    };
    expect(everything()).toContain('Anna wants the budget by Friday.'); // really stored (even though nothing was cited)
    expect((await captures(a, s)).find((c) => c.id === asked.id)!.answer!.redacted).toBe(false);

    expect((await authed(a, s, 'DELETE', `/api/notes/${note.id}`)).statusCode).toBe(204);
    const after = (await captures(a, s)).find((c) => c.id === asked.id)!;
    expect(after.answer).toEqual({ text: '', sources: [], redacted: true });
    expect(JSON.stringify(after)).not.toContain('Friday');

    purgeDeleted(deps.db, new Date(FIXED_NOW.getTime() + 31 * 86_400_000));
    expect(everything()).not.toContain('Anna wants the budget by Friday.');
    expect(everything()).not.toContain('QA-NOTE');
    expect((await captures(a, s)).find((c) => c.id === asked.id)).toBeUndefined();
  });

  it('with the fake LLM: a trailing ? is answered without a prefix, !!fail fails, undo erases', async () => {
    const { a, deps } = await boot();
    const s = await login(a, deps);
    await seed(a, s);
    const q = (await authed(a, s, 'POST', '/api/captures', { text: 'what did I note about Anna?', source: 'text' })).json() as Capture;
    expect(q).toMatchObject({ status: 'asked', classifiedBy: 'llm' });
    const ok = (await authed(a, s, 'POST', `/api/captures/${q.id}/ask`)).json() as Capture;
    expect(ok.answer!.text).toMatch(/^Found \d+ item\(s\): /);
    expect(ok.answer!.sources.length).toBeGreaterThan(0);
    expect((await authed(a, s, 'POST', `/api/captures/${q.id}/undo`)).json()).toMatchObject({ status: 'discarded', answer: null });

    const bad = (await authed(a, s, 'POST', '/api/captures', { text: '/ask Anna !!fail', source: 'text' })).json() as Capture;
    expect((await authed(a, s, 'POST', `/api/captures/${bad.id}/ask`)).statusCode).toBe(502);
  });
});
