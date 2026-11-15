import cookie from '@fastify/cookie';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { serverOptions } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import type { Config } from '../src/server/config.ts';
import { migrate } from '../src/server/db/migrate.ts';
import { openDb } from '../src/server/db/open.ts';
import type { AppDeps } from '../src/server/deps.ts';
import { installErrorHandler, notFoundHandler } from '../src/server/errors.ts';
import { FakeClassifier, FakeTranscriber } from '../src/server/llm/fake.ts';

export const TEST_ORIGIN = 'http://localhost:5173';
export const FIXED_NOW = new Date('2026-01-15T12:00:00.000Z');

/** In-memory, fully migrated database. */
export function makeTestDb(): DatabaseSync {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Test config: explicit env and an injected file reader, so the real key file is never touched. */
export function makeTestConfig(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig(
    {
      XO_DB_PATH: ':memory:',
      XO_PUBLIC_ORIGIN: TEST_ORIGIN,
      XO_COOKIE_INSECURE: 'true',
      XO_LLM: 'fake',
      ...env,
    },
    () => null,
  ).config;
}

/** Deps with a test DB, fake LLM/STT, fixed clock and test config. */
export function makeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    config: makeTestConfig(),
    db: makeTestDb(),
    classifier: new FakeClassifier(),
    transcriber: new FakeTranscriber(),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

type RoutePlugin = (app: FastifyInstance, opts: { deps: AppDeps }) => Promise<void>;

/**
 * Bare Fastify instance for testing one route plugin in isolation: same server options and error /
 * not-found handlers as the real app, @fastify/cookie registered like app.ts does, and the plugin
 * mounted under prefix '/api' like the real app. No auth guard, no helmet, no static serving.
 */
export async function makeRouteApp(plugin: RoutePlugin, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify(serverOptions(deps, false));
  installErrorHandler(app);
  app.setNotFoundHandler(notFoundHandler);
  await app.register(cookie);
  await app.register(plugin, { deps, prefix: '/api' });
  await app.ready();
  return app;
}
