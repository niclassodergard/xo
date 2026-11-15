import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { makeDeps, makeTestConfig, TEST_ORIGIN } from '../../../test/helpers.ts';
import type { AppDeps } from '../deps.ts';
import { buildApp, serverOptions } from '../app.ts';
import { installErrorHandler } from '../errors.ts';
import authRoutes from './auth.ts';
import { hashPassword, verifyPassword } from '../auth/password.ts';
import { createDevice } from '../auth/devices.ts';
import { hashToken } from '../auth/sessions.ts';
import { base32Encode, totpAt } from '../auth/totp.ts';

vi.mock('../auth/password.ts', async (orig) => {
  const real = await orig<typeof import('../auth/password.ts')>();
  return { ...real, verifyPassword: vi.fn(real.verifyPassword) };
});

const PASSWORD = 'correct horse battery';
const SECRET = base32Encode(Buffer.from('12345678901234567890'));

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function seedUser(deps: AppDeps, lastStep = 0): Promise<void> {
  const hash = await hashPassword(PASSWORD, { N: 16, r: 8, p: 1 });
  deps.db.prepare('INSERT INTO user (id, password_hash, totp_secret, totp_last_step, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?)')
    .run(hash, SECRET, lastStep, 'x', 'x');
}

function post(a: FastifyInstance, body: unknown, headers: Record<string, string> = {}, remoteAddress?: string): Promise<LightMyRequestResponse> {
  return a.inject({
    method: 'POST', url: '/api/auth/login', payload: body as object, remoteAddress,
    headers: { origin: TEST_ORIGIN, ...headers },
  });
}

describe('POST /api/auth/login', () => {
  it('logs in, sets the dev cookie and returns a CSRF token that works', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { csrfToken } = res.json() as { csrfToken: string };
    expect(csrfToken).toBeTruthy();
    const cookie = res.cookies[0]!;
    expect(cookie.name).toBe('xo_session');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy();
    const sess = await app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: `xo_session=${cookie.value}` } });
    expect(sess.statusCode).toBe(200);
    expect(sess.json()).toEqual({ csrfToken });
  });

  it('sets __Host-, Secure, HttpOnly, SameSite=Strict, Path=/ and no Domain from config', async () => {
    const config = makeTestConfig({ XO_COOKIE_INSECURE: 'false', XO_PUBLIC_ORIGIN: 'https://xo.example.com' });
    const deps = makeDeps({ config });
    await seedUser(deps);
    app = await buildApp(deps);
    // Cookie attributes must not follow forwarded headers: this request claims plain http.
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) },
      { origin: 'https://xo.example.com', 'x-forwarded-proto': 'http' });
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/^__Host-xo_session=/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');
    expect(raw).not.toMatch(/Domain=/i);
    expect(raw).toMatch(/Max-Age=2592000/);
  });

  it('gives the same 401 for wrong password, wrong code, replayed code and no user', async () => {
    const deps = makeDeps();
    app = await buildApp(deps);
    const noUser = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.0.0.1');
    await seedUser(deps);
    const code = totpAt(SECRET, deps.now());
    const badPw = await post(app, { password: 'wrong password!!', totp: code }, {}, '10.0.0.2');
    const badCode = await post(app, { password: PASSWORD, totp: code === '000000' ? '000001' : '000000' }, {}, '10.0.0.3');
    deps.db.prepare('UPDATE user SET totp_last_step = ?').run(Math.floor(deps.now().getTime() / 30_000));
    const replay = await post(app, { password: PASSWORD, totp: code }, {}, '10.0.0.4');
    for (const r of [noUser, badPw, badCode, replay]) {
      expect(r.statusCode).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.body).toBe(noUser.body);
    }
    expect(noUser.json()).toEqual({ error: { code: 'invalid_credentials', message: 'Invalid credentials' } });
  });

  it('does not burn the TOTP step when the password is wrong', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const code = totpAt(SECRET, deps.now());
    expect((await post(app, { password: 'wrong password!!', totp: code })).statusCode).toBe(401);
    expect((await post(app, { password: PASSWORD, totp: code })).statusCode).toBe(200);
  });

  it('rejects reuse of a code after a successful login', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const body = { password: PASSWORD, totp: totpAt(SECRET, deps.now()) };
    expect((await post(app, body)).statusCode).toBe(200);
    expect((await post(app, body)).statusCode).toBe(401);
  });

  it('rate limits the 6th failed attempt per IP with Retry-After, without scrypt work', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    for (let i = 0; i < 5; i++) {
      expect((await post(app, { password: 'wrong password!!', totp: '000000' }, {}, '10.1.1.1')).statusCode).toBe(401);
    }
    const limited = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.1.1.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('900');
    expect(limited.json().error.code).toBe('rate_limited');
    // Another IP is unaffected.
    expect((await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.1.1.2')).statusCode).toBe(200);
  });

  it('applies the global limit across IPs', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    for (let i = 0; i < 20; i++) {
      const r = await post(app, { password: 'wrong password!!', totp: '000000' }, {}, `10.2.${Math.floor(i / 4)}.${i % 4}`);
      expect(r.statusCode).toBe(401);
    }
    const r = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.3.0.1');
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('lifts the lockout once the window has passed', async () => {
    let now = new Date('2026-01-15T12:00:00Z');
    const deps = makeDeps({ now: () => now });
    await seedUser(deps);
    app = await buildApp(deps);
    for (let i = 0; i < 5; i++) await post(app, { password: 'wrong password!!', totp: '000000' });
    expect((await post(app, { password: PASSWORD, totp: totpAt(SECRET, now) })).statusCode).toBe(429);
    now = new Date(now.getTime() + 15 * 60_000 + 1000);
    expect((await post(app, { password: PASSWORD, totp: totpAt(SECRET, now) })).statusCode).toBe(200);
  });

  it('keys the limiter on req.ip: X-Forwarded-For is ignored without trust proxy', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    for (let i = 0; i < 5; i++) {
      await post(app, { password: 'wrong password!!', totp: '000000' }, { 'x-forwarded-for': `1.2.3.${i}` }, '10.4.4.4');
    }
    const r = await post(app, { password: 'wrong password!!', totp: '000000' }, { 'x-forwarded-for': '9.9.9.9' }, '10.4.4.4');
    expect(r.statusCode).toBe(429);
  });

  it('requires Origin equal to the public origin', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const body = { password: PASSWORD, totp: totpAt(SECRET, deps.now()) };
    for (const origin of [undefined, 'https://evil.example', 'http://localhost:5173/']) {
      const res = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: body, headers: origin ? { origin } : {},
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('requires a JSON content type', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: 'password=x&totp=1',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(res.statusCode).toBe(415);
    const text = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: '{}', headers: { origin: TEST_ORIGIN, 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(415);
  });

  it('validates the body strictly and enforces a small body limit', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    expect((await post(app, { password: PASSWORD })).statusCode).toBe(400);
    expect((await post(app, { password: PASSWORD, totp: '123456', extra: 1 })).statusCode).toBe(400);
    expect((await post(app, { password: 1, totp: '123456' })).statusCode).toBe(400);
    const big = await post(app, { password: 'x'.repeat(5000), totp: '123456' });
    expect(big.statusCode).toBe(413);
  });

  it('purges expired sessions on login and replaces a previous session', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    deps.db.prepare("INSERT INTO sessions VALUES ('old', 'c', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', '2020-02-01T00:00:00.000Z')").run();
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) });
    expect(res.statusCode).toBe(200);
    const rows = deps.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe('old');
  });
});

describe('login limits and trusted devices', () => {
  const bad = { password: 'wrong password!!', totp: '000000' };

  async function saturate(a: FastifyInstance, ip: string, n = 5): Promise<void> {
    for (let i = 0; i < n; i++) await post(a, bad, {}, ip);
  }

  it('does no password work for a locked-out caller (429)', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    await saturate(app, '10.6.6.6');
    vi.mocked(verifyPassword).mockClear();
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.6.6.6');
    expect(res.statusCode).toBe(429);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it('sets a hashed trusted-device cookie on success with the session cookie attributes', async () => {
    const config = makeTestConfig({ XO_COOKIE_INSECURE: 'false', XO_PUBLIC_ORIGIN: 'https://xo.example.com' });
    const deps = makeDeps({ config });
    await seedUser(deps);
    app = await buildApp(deps);
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, { origin: 'https://xo.example.com' });
    const dev = res.cookies.find((c) => c.name === '__Host-xo_device')!;
    expect(dev.httpOnly).toBe(true);
    expect(dev.secure).toBe(true);
    expect(dev.sameSite).toBe('Strict');
    expect(dev.path).toBe('/');
    expect(dev.maxAge).toBe(365 * 86_400);
    const rows = deps.db.prepare('SELECT token_hash FROM devices').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(dev.value);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a valid device cookie bypasses a saturated IP and global lockout', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const device = createDevice(deps.db, deps.now());
    for (let i = 0; i < 20; i++) await post(app, bad, {}, `10.7.${Math.floor(i / 4)}.${i % 4}`);
    const blocked = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.7.9.9');
    expect(blocked.statusCode).toBe(429);
    const ok = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, { cookie: `xo_device=${device}` }, '10.7.9.9');
    expect(ok.statusCode).toBe(200);
    // The token was rotated.
    expect(ok.cookies.find((c) => c.name === 'xo_device')!.value).not.toBe(device);
    expect(deps.db.prepare('SELECT COUNT(*) AS c FROM devices').get()).toEqual({ c: 1 });
  });

  it('forged, unknown or expired device cookies get the normal limits', async () => {
    let now = new Date('2026-01-15T12:00:00Z');
    const deps = makeDeps({ now: () => now });
    await seedUser(deps);
    app = await buildApp(deps);
    const expired = createDevice(deps.db, new Date('2024-01-01T00:00:00Z'));
    await saturate(app, '10.8.8.8');
    const code = totpAt(SECRET, now);
    for (const value of ['forged', 'A'.repeat(43), expired, 'x'.repeat(5000)]) {
      const res = await post(app, { password: PASSWORD, totp: code }, { cookie: `xo_device=${value}` }, '10.8.8.8');
      expect(res.statusCode).toBe(429);
    }
  });

  it('rate limits the device itself: 5 failures, then 429, other IPs notwithstanding', async () => {
    const deps = makeDeps();
    await seedUser(deps);
    app = await buildApp(deps);
    const device = createDevice(deps.db, deps.now());
    const h = { cookie: `xo_device=${device}` };
    for (let i = 0; i < 5; i++) expect((await post(app, bad, h, `10.9.0.${i}`)).statusCode).toBe(401);
    const res = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, h, '10.9.1.1');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('900');
    // Anonymous callers are unaffected by the device's failures.
    expect((await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, {}, '10.9.2.2')).statusCode).toBe(200);
  });
});

describe('logout and trusted devices', () => {
  it('revokes the presented device token and clears both cookies', async () => {
    const config = makeTestConfig({ XO_COOKIE_INSECURE: 'false', XO_PUBLIC_ORIGIN: 'https://xo.example.com' });
    const deps = makeDeps({ config });
    await seedUser(deps);
    app = await buildApp(deps);
    const origin = 'https://xo.example.com';
    const login = await post(app, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) }, { origin });
    const sess = login.cookies.find((c) => c.name === '__Host-xo_session')!.value;
    const dev = login.cookies.find((c) => c.name === '__Host-xo_device')!.value;
    const other = createDevice(deps.db, deps.now());
    const csrf = (login.json() as { csrfToken: string }).csrfToken;
    const out = await app.inject({
      method: 'POST', url: '/api/auth/logout',
      headers: { origin, 'x-xo-csrf': csrf, cookie: `__Host-xo_session=${sess}; __Host-xo_device=${dev}` },
    });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === '__Host-xo_device')!;
    expect(cleared.value).toBe('');
    expect(cleared.path).toBe('/');
    expect(cleared.secure).toBe(true);
    expect(cleared.httpOnly).toBe(true);
    expect(cleared.sameSite).toBe('Strict');
    // Only the presented device is gone; another device stays.
    const rows = deps.db.prepare('SELECT token_hash FROM devices').all() as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashToken(other));
  });
});

describe('login logging', () => {
  it('logs failures and lockouts with the ip and never the credentials', async () => {
    const lines: string[] = [];
    const deps = makeDeps();
    await seedUser(deps);
    // Standalone app (route plugin only) so a capture stream can be attached to the logger.
    app = Fastify({ ...serverOptions(deps, false), logger: { level: 'info', stream: { write: (l: string) => { lines.push(l); } } } });
    installErrorHandler(app);
    await app.register(cookie);
    await app.register(authRoutes, { deps, prefix: '/api' });
    const bad = { password: 'hunter2-wrong-pw', totp: '654321' };
    for (let i = 0; i < 6; i++) {
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: bad, remoteAddress: '10.5.5.5' });
    }
    const out = lines.join('');
    expect(out).toContain('login failed');
    expect(out).toContain('login locked out');
    expect(out).toContain('10.5.5.5');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('654321');
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toMatch(/xo_device|xo_session/);
  });
});

describe('session and logout', () => {
  async function loggedIn(deps: AppDeps) {
    await seedUser(deps);
    const a = await buildApp(deps);
    const res = await post(a, { password: PASSWORD, totp: totpAt(SECRET, deps.now()) });
    return { a, cookie: `xo_session=${res.cookies[0]!.value}`, csrf: (res.json() as { csrfToken: string }).csrfToken };
  }

  it('GET /api/auth/session is 401 without a session', async () => {
    app = await buildApp(makeDeps());
    expect((await app.inject({ method: 'GET', url: '/api/auth/session' })).statusCode).toBe(401);
  });

  it('logout needs CSRF, then invalidates the session and clears the cookie', async () => {
    const deps = makeDeps();
    const { a, cookie, csrf } = await loggedIn(deps);
    app = a;
    const noCsrf = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: TEST_ORIGIN } });
    expect(noCsrf.statusCode).toBe(403);
    const out = await a.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, origin: TEST_ORIGIN, 'x-xo-csrf': csrf } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/xo_session=;/);
    expect((await a.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('a session expires per config', async () => {
    let now = new Date('2026-01-15T12:00:00Z');
    const deps = makeDeps({ now: () => now });
    const { a, cookie } = await loggedIn(deps);
    app = a;
    now = new Date('2026-01-23T12:00:00Z'); // 8 days idle
    expect((await a.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });
});
