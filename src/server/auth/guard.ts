import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.ts';
import { timingSafeEqual } from 'node:crypto';
import { sendError } from '../errors.ts';
import { purgeExpiredDevices } from './devices.ts';
import { lookupSession, purgeExpiredSessions, sessionCookieName } from './sessions.ts';
import type { SessionInfo } from './sessions.ts';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Route opt-out from the auth guard. Only health and login may set this. */
    public?: boolean;
  }
}

/**
 * Is this URL path an API path? Used for requests that matched no route (404s), where the router's
 * own idea of the route is unavailable. Fail closed: percent-decode (repeatedly, case-folded) and
 * treat a decode failure as API. Percent-encoded spellings like /%61pi/x or /api%2Fx count as API.
 */
export function isApiPath(rawUrl: string): boolean {
  let path = rawUrl.split('?', 1)[0] ?? '';
  for (let i = 0; i < 4; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return true;
    }
    if (decoded === path) break;
    path = decoded;
  }
  // Collapse leading slashes and backslashes ('//api/x', '/%5capi/x') so they cannot hide the prefix.
  path = path.replace(/^[\\/]+/, '/').toLowerCase();
  return path === '/api' || path.startsWith('/api/');
}

/** Single definition of "API request" for the guard fallback, Cache-Control and the SPA fallback. */
export function isApiRequest(req: FastifyRequest): boolean {
  const routed = req.routeOptions?.url;
  if (routed && (routed === '/api' || routed.startsWith('/api/'))) return true;
  return isApiPath(req.url);
}

const sessions = new WeakMap<FastifyRequest, SessionInfo>();

/** The session attached to this request by `isAuthenticated`, if any. */
export function getSession(req: FastifyRequest): SessionInfo | null {
  return sessions.get(req) ?? null;
}

/**
 * Does this request carry a valid session cookie? On success the session (with its CSRF token) is
 * attached to the request, see `getSession`. Used by the guard hook and the not-found fallback.
 */
export async function isAuthenticated(req: FastifyRequest, deps: AppDeps): Promise<boolean> {
  const cached = sessions.get(req);
  if (cached) return true;
  const token = req.cookies?.[sessionCookieName(deps.config)];
  if (typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
  const session = lookupSession(deps.db, deps.config, token, deps.now());
  if (!session) return false;
  sessions.set(req, session);
  return true;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Global auth guard. app.ts calls this exactly once, directly (not via app.register), on the
 * `/api`-prefixed scope that contains every API route, and again uses `isAuthenticated` for the
 * not-found fallback, so unmatched /api URLs are 401 too.
 *
 * Every route in the scope requires a session unless it declares `config: { public: true }`
 * (read through req.routeOptions.config). There are no URL-string exemptions.
 *
 * Order per request: session (401, non-public only) -> Origin for non-GET/HEAD (403, public routes
 * included, compared only to config.publicOrigin) -> CSRF header for authenticated non-GET/HEAD (403).
 * Expired sessions are purged once here, at startup.
 */
export default async function authGuard(app: FastifyInstance, opts: { deps: AppDeps }): Promise<void> {
  const { deps } = opts;
  purgeExpiredSessions(deps.db, deps.config, deps.now());
  purgeExpiredDevices(deps.db, deps.now());
  app.addHook('onRequest', async (req, reply) => {
    const isPublic = req.routeOptions.config.public === true;
    if (!isPublic && !(await isAuthenticated(req, deps))) {
      return sendError(reply, 401, 'unauthenticated', 'Authentication required');
    }
    if (req.method === 'GET' || req.method === 'HEAD') return;
    if (req.headers.origin !== deps.config.publicOrigin) {
      return sendError(reply, 403, 'forbidden', 'Forbidden');
    }
    if (isPublic) return;
    const header = req.headers['x-xo-csrf'];
    const session = getSession(req);
    if (!session || typeof header !== 'string' || !safeEqual(header, session.csrfToken)) {
      return sendError(reply, 403, 'forbidden', 'Forbidden');
    }
  });
}
