import { buildApp } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { migrate } from '../src/server/db/migrate.ts';
import { openDb } from '../src/server/db/open.ts';
import { pickLlm } from '../src/server/llm/pick.ts';
import type { AppDeps } from '../src/server/deps.ts';

// Test launcher for the e2e suite (started by e2e/global-setup.ts with an explicit, minimal environment).
// Same wiring as src/server/main.ts, except that the client is served from XO_E2E_CLIENT_DIR (a per-run
// build, see global-setup) through buildApp's code-level `clientDir` option. This file is test-only: the
// production entry point never reads that variable.

const clientDir = process.env['XO_E2E_CLIENT_DIR'];
if (!clientDir) throw new Error('XO_E2E_CLIENT_DIR is not set (this file is started by e2e/global-setup.ts)');

const { config, openRouterApiKey } = loadConfig(process.env);
const db = openDb(config.dbPath);
migrate(db);
const deps: AppDeps = { config, db, ...pickLlm(config, openRouterApiKey), now: () => new Date() };
const app = await buildApp(deps, { logger: false, clientDir });

const shutdown = (): void => {
  app.close().finally(() => { db.close(); process.exit(0); });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
