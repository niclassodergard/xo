import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse, RouteOptions } from 'fastify';
import { buildApp } from '../../src/server/app.ts';
import { base32Encode, totpAt } from '../../src/server/auth/totp.ts';
import { setupUser } from '../../src/server/cli/setup.ts';
import type { AppDeps } from '../../src/server/deps.ts';
import { pickLlm } from '../../src/server/llm/pick.ts';
import type { Action, Capture, Note } from '../../src/shared/types.ts';
import { makeDeps, makeTestConfig, TEST_ORIGIN } from '../helpers.ts';

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

function authed(a: FastifyInstance, s: Session, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object): Promise<LightMyRequestResponse> {
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
      const content = JSON.stringify({ kind: 'note', confidence: 0.95, personName: null, owner: 'me' });
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
