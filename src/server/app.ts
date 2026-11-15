import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions, RouteOptions } from 'fastify';
import authGuard, { isApiPath, isApiRequest, isAuthenticated } from './auth/guard.ts';
import type { AppDeps } from './deps.ts';
import { installErrorHandler, notFoundHandler, sendError } from './errors.ts';
import actionsRoutes from './routes/actions.ts';
import agendaRoutes from './routes/agenda.ts';
import authRoutes from './routes/auth.ts';
import capturesRoutes from './routes/captures.ts';
import meetingsRoutes from './routes/meetings.ts';
import navRoutes from './routes/nav.ts';
import notesRoutes from './routes/notes.ts';
import peopleRoutes from './routes/people.ts';
import projectsRoutes from './routes/projects.ts';
import searchRoutes from './routes/search.ts';
import voiceRoutes from './routes/voice.ts';

const GUARDED_SCOPE = 'xoGuardedApiScope';
const PERMISSIONS_POLICY = 'camera=(), geolocation=(), payment=(), usb=(), display-capture=(), microphone=(self)';

const DEFAULT_CLIENT_DIR = fileURLToPath(new URL('../../dist/client/', import.meta.url));

function trustProxyOption(tp: AppDeps['config']['trustProxy']): boolean | string[] | ((address: string, hop: number) => boolean) {
  // A hop count n means: trust the n nearest proxies (same semantics as proxy-addr's number form).
  return typeof tp === 'number' ? (_address, hop) => hop < tp : tp;
}

/** Fastify options shared by the real app and the test helper `makeRouteApp`. */
export function serverOptions(deps: AppDeps, logger: boolean): FastifyServerOptions {
  return {
    // Malformed URLs (bad percent-encoding) fail before routing and hooks; answer in the shared error
    // shape, and fail closed with no-store for anything that could be an API path.
    frameworkErrors: (err, req, reply) => {
      reply.header('Permissions-Policy', PERMISSIONS_POLICY);
      if (isApiRequest(req)) reply.header('Cache-Control', 'no-store');
      const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 400;
      return sendError(reply, status, 'bad_request', 'Bad request');
    },
    trustProxy: trustProxyOption(deps.config.trustProxy),
    logger: logger
      ? {
          level: 'info',
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
          serializers: {
            // Path only: query strings can hold search text. Never log headers or bodies.
            req: (req: { method?: string; url?: string }) => ({ method: req.method, path: (req.url ?? '').split('?', 1)[0] }),
          },
        }
      : false,
    // Validation must be strict: unknown properties are rejected (not stripped) and values are never
    // coerced (`{text: 123}` is a 400, `null` is not an integer). Consequences for route authors:
    // nullable fields must declare type ['integer','null'], and querystring params arrive as strings,
    // so declare them as strings (with a digit `pattern` for ids/limits) and convert in the handler.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  };
}

/**
 * Must a route with this URL live inside the guarded scope? True for /api paths (decoded, any case)
 * and for root-level routes whose first segment contains a parameter, wildcard or regex marker (`:`, `*`, `(`) (`/:x/...`, `/*`, `*`),
 * which could otherwise match /api paths.
 */
export function mustBeGuarded(url: string): boolean {
  if (isApiPath(url)) return true;
  return url === '*' || /^\/?[^/]*[:*(]/.test(url);
}

/**
 * Builds the full app. Route modules are registered under prefix '/api' and declare relative paths.
 * `logger` is off by default (tests); main.ts turns it on.
 */
export async function buildApp(
  deps: AppDeps,
  opts: { logger?: boolean; onRoute?: (route: RouteOptions) => void; clientDir?: string } = {},
): Promise<FastifyInstance> {
  const app = Fastify(serverOptions(deps, opts.logger ?? false));
  const { config } = deps;
  // Installed before anything else is registered, so no route can slip past it.
  // An /api route (decoded, case-insensitive) must live in the guarded scope below; otherwise
  // registration throws, so an unguarded /api route cannot ship.
  app.addHook('onRoute', function (this: FastifyInstance, route) {
    if (mustBeGuarded(route.url) && !(this as unknown as Record<string, unknown>)[GUARDED_SCOPE]) {
      throw new Error(`route ${String(route.method)} ${route.url} is under /api (or could match it) but not inside the guarded /api scope`);
    }
  });
  // Used by the step 12 route sweep.
  if (opts.onRoute) app.addHook('onRoute', opts.onRoute);

  installErrorHandler(app);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        // Plain-http dev origins would break if subresources were upgraded.
        ...(config.cookieInsecure ? {} : { upgradeInsecureRequests: [] }),
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });

  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
  });
  app.addHook('onSend', async (req, reply) => {
    if (isApiRequest(req)) reply.header('Cache-Control', 'no-store');
  });

  // Every API route lives in this one scope; the guard hook covers all of them (fail closed).
  // Routes opt out only through `config: { public: true }`.
  await app.register(
    async (api) => {
      api.decorate(GUARDED_SCOPE, true); // marks this scope (and its children) as guarded
      await authGuard(api, { deps });
      api.route({
        method: ['GET', 'HEAD'],
        url: '/health',
        config: { public: true },
        handler: async () => ({ ok: true }),
      });
      const opts = { deps };
      await api.register(authRoutes, opts);
      await api.register(peopleRoutes, opts);
      await api.register(projectsRoutes, opts);
      await api.register(navRoutes, opts);
      await api.register(notesRoutes, opts);
      await api.register(actionsRoutes, opts);
      await api.register(agendaRoutes, opts);
      await api.register(meetingsRoutes, opts);
      await api.register(searchRoutes, opts);
      await api.register(capturesRoutes, opts);
      await api.register(voiceRoutes, opts);
    },
    { prefix: '/api' },
  );

  // Unmatched requests never reach the scope's hooks, so guard them here: any API-looking path
  // (decoded, fail closed) is 401 unless authenticated, then 404.
  // `clientDir` is a code-level option (tests, e2e) and never read from the environment.
  const clientDir = opts.clientDir ?? DEFAULT_CLIENT_DIR;
  const serveSpa = existsSync(clientDir);
  if (serveSpa) {
    // wildcard:false registers the files present at startup only (no directory traversal surface).
    await app.register(fastifyStatic, { root: clientDir, wildcard: false });
  }
  app.setNotFoundHandler(async (req, reply) => {
    if (isApiRequest(req)) {
      if (!(await isAuthenticated(req, deps))) return sendError(reply, 401, 'unauthenticated', 'Authentication required');
      return notFoundHandler(req, reply);
    }
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (serveSpa && (req.method === 'GET' || req.method === 'HEAD') && wantsHtml) {
      return reply.sendFile('index.html');
    }
    return notFoundHandler(req, reply);
  });

  return app;
}
