import type { FastifyInstance } from 'fastify';
import { createDevice, deleteDevice, deviceCookieName, DEVICE_TTL_DAYS, lookupDevice, purgeExpiredDevices } from '../auth/devices.ts';
import { SCRYPT_DEFAULTS, hashPassword, verifyPassword } from '../auth/password.ts';
import { getSession } from '../auth/guard.ts';
import { createLoginLimiter } from '../auth/rate-limit.ts';
import { createSession, deleteSession, purgeExpiredSessions, sessionCookieName } from '../auth/sessions.ts';
import { generateSecret, verifyTotp } from '../auth/totp.ts';
import type { AppDeps } from '../deps.ts';
import { sendError } from '../errors.ts';
import type { LoginRequest, SessionResponse } from '../../shared/api.ts';

const LOGIN_BODY_LIMIT = 2048;
const NO_QUERY = { type: 'object', additionalProperties: false } as const;

// Used when no user row exists, so the work done per attempt is the same either way.
let dummy: Promise<{ hash: string; secret: string }> | undefined;
function dummyCredentials(): Promise<{ hash: string; secret: string }> {
  dummy ??= hashPassword('xo-dummy-password', SCRYPT_DEFAULTS).then((hash) => ({ hash, secret: generateSecret() }));
  // A failed computation must not be cached forever.
  dummy.catch(() => { dummy = undefined; });
  return dummy;
}

export default async function routes(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;
  const { config } = deps;
  const cookieName = sessionCookieName(config);
  // Cookie attributes come from config only, never from req.protocol (forwarded headers are spoofable).
  const cookieBase = { path: '/', httpOnly: true, secure: !config.cookieInsecure, sameSite: 'strict' } as const;
  const deviceCookie = deviceCookieName(config);
  const limiter = createLoginLimiter({ now: deps.now });

  app.post<{ Body: LoginRequest }>('/auth/login', {
    config: { public: true },
    bodyLimit: LOGIN_BODY_LIMIT,
    // Runs after the guard's Origin check; the body has not been parsed yet.
    onRequest: async (req, reply) => {
      if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        return sendError(reply, 415, 'unsupported_media_type', 'Content-Type must be application/json');
      }
    },
    schema: {
      querystring: NO_QUERY,
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['password', 'totp'],
        properties: {
          password: { type: 'string', minLength: 1, maxLength: 256 },
          totp: { type: 'string', minLength: 1, maxLength: 16 },
        },
      },
    },
  }, async (req, reply) => {
    const ip = req.ip;
    // A valid trusted-device cookie moves this attempt into the device's own bucket. Forged or unknown
    // tokens fall back to the normal per-IP and global limits.
    const deviceId = lookupDevice(deps.db, req.cookies[deviceCookie], deps.now());
    const limit = limiter.attempt(ip, deviceId);
    if (!limit.allowed) {
      req.log.warn({ ip, trustedDevice: deviceId !== null }, 'login locked out');
      reply.header('Retry-After', String(limit.retryAfterSeconds));
      return sendError(reply, 429, 'rate_limited', 'Too many attempts, try again later');
    }
    const { password, totp } = req.body;
    const user = deps.db.prepare('SELECT password_hash, totp_secret, totp_last_step FROM user WHERE id = 1')
      .get() as { password_hash: string; totp_secret: string; totp_last_step: number } | undefined;
    const fallback = user ? null : await dummyCredentials();
    // Always do both checks, whatever failed first.
    const passwordOk = await verifyPassword(password, user?.password_hash ?? fallback!.hash);
    const step = verifyTotp(user?.totp_secret ?? fallback!.secret, totp, deps.now(), user?.totp_last_step ?? 0);
    let ok = user !== undefined && passwordOk && step !== null;
    if (ok) {
      // Atomic replay protection: only one request can advance the step.
      const res = deps.db.prepare('UPDATE user SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?').run(step, step);
      ok = Number(res.changes) === 1;
    }
    if (!ok) {
      req.log.warn({ ip, trustedDevice: deviceId !== null }, 'login failed');
      return sendError(reply, 401, 'invalid_credentials', 'Invalid credentials');
    }
    limiter.succeed(ip, deviceId);
    const now = deps.now();
    purgeExpiredSessions(deps.db, config, now);
    purgeExpiredDevices(deps.db, now);
    const previous = req.cookies[cookieName];
    if (previous) deleteSession(deps.db, previous);
    const session = createSession(deps.db, config, now);
    reply.setCookie(cookieName, session.token, { ...cookieBase, maxAge: Math.floor(config.sessionTtlDays * 86_400) });
    // Rotate the trusted-device token on every successful login.
    if (deviceId) deleteDevice(deps.db, deviceId);
    reply.setCookie(deviceCookie, createDevice(deps.db, now), { ...cookieBase, maxAge: DEVICE_TTL_DAYS * 86_400 });
    const body: SessionResponse = { csrfToken: session.csrfToken };
    return body;
  });

  app.get('/auth/session', { schema: { querystring: NO_QUERY } }, async (req, reply) => {
    // The guard has authenticated the request and attached the session; fail closed if it did not.
    const session = getSession(req);
    if (!session) return sendError(reply, 401, 'unauthenticated', 'Authentication required');
    const body: SessionResponse = { csrfToken: session.csrfToken };
    return body;
  });

  app.post('/auth/logout', { schema: { querystring: NO_QUERY } }, async (req, reply) => {
    const token = req.cookies[cookieName];
    if (token) deleteSession(deps.db, token);
    // Also revoke the presented trusted-device token, so logging out on a borrowed machine leaves nothing.
    const deviceId = lookupDevice(deps.db, req.cookies[deviceCookie], deps.now());
    if (deviceId) deleteDevice(deps.db, deviceId);
    reply.clearCookie(cookieName, cookieBase);
    reply.clearCookie(deviceCookie, cookieBase);
    return reply.code(204).send();
  });
}
