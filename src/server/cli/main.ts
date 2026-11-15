import { loadConfig } from '../config.ts';
import { openDb } from '../db/open.ts';
import { migrate } from '../db/migrate.ts';

const USAGE = 'Usage: pnpm xo <setup [--force] | export [--out <dir>]>';

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command !== 'setup' && command !== 'export') {
    console.error(USAGE);
    return 2;
  }
  // CLI commands never need the OpenRouter key, so the key file is not touched.
  const { config } = loadConfig(process.env, undefined, { loadApiKey: false });
  const db = openDb(config.dbPath);
  try {
    migrate(db);
    const mod = command === 'setup' ? await import('./setup.ts') : await import('./export.ts');
    await mod.run(args, { config, db });
    return 0;
  } finally {
    db.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    // Print the message only: never dump config or objects that could hold secrets.
    console.error(`xo: ${err instanceof Error ? err.message : 'failed'}`);
    process.exitCode = 1;
  },
);
