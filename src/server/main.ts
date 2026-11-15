import { buildApp } from './app.ts';
import { isLoopbackHost, loadConfig } from './config.ts';
import { migrate } from './db/migrate.ts';
import { pickLlm } from './llm/pick.ts';
import { openDb } from './db/open.ts';
import { purgeDeleted } from './repos/purge.ts';
import type { AppDeps } from './deps.ts';

async function main(): Promise<void> {
  // The key stays local to this function: it is passed only to the OpenRouter factory.
  const { config, openRouterApiKey } = loadConfig(process.env);
  const db = openDb(config.dbPath);
  migrate(db);

  const deps: AppDeps = { config, db, ...pickLlm(config, openRouterApiKey), now: () => new Date() };
  const app = await buildApp(deps, { logger: true });

  if (!db.prepare('SELECT 1 AS x FROM user').get()) {
    app.log.warn('no user configured: run "pnpm xo setup" (logins fail until then)');
  }
  if (config.llm === 'openrouter') {
    app.log.info(`OpenRouter ZDR: ${config.openRouterZdr ? 'on' : 'off'}`);
  }
  if (config.trustProxy === false && !isLoopbackHost(new URL(config.publicOrigin).hostname)) {
    app.log.warn('XO_TRUST_PROXY is not set but XO_PUBLIC_ORIGIN is not loopback: behind a reverse proxy every client shares the proxy IP, so the login rate limit would lock everyone out together. Set XO_TRUST_PROXY.');
  }
  if (!deps.classifier) {
    app.log.warn('no LLM key configured: captures without a prefix will ask for the kind; voice is disabled');
  }

  // Soft-deleted notes/actions/agenda items are erased after 30 days (user decision).
  // Runs at startup and then daily. Logs counts only, never contents.
  const purge = (): void => {
    try {
      const n = purgeDeleted(db, deps.now());
      if (n.notes + n.actions + n.agendaItems + n.captures > 0) app.log.info({ purged: n }, 'purged soft-deleted items');
    } catch (err) {
      app.log.error(`purge failed: ${err instanceof Error ? err.name : 'unknown error'}`);
    }
  };
  purge();
  const purgeTimer = setInterval(purge, 24 * 60 * 60 * 1000);
  purgeTimer.unref();

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(purgeTimer);
    try {
      await app.close();
    } finally {
      db.close();
    }
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      shutdown().then(() => process.exit(0), () => process.exit(1));
    });
  }

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  // Message only: never print config objects.
  console.error(`xo: failed to start: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
});
