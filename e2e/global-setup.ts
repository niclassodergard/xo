import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateSecret, totpAt } from '../src/server/auth/totp.ts';
import { setupUser } from '../src/server/cli/setup.ts';
import { migrate } from '../src/server/db/migrate.ts';
import { openDb } from '../src/server/db/open.ts';

export const E2E_PASSWORD = 'correct horse battery';

const ROOT = resolve(import.meta.dirname, '..');

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

async function waitForHealth(base: string, server: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`XO server exited early (code ${server.exitCode}):\n${log()}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`XO server did not become healthy:\n${log()}`);
}

/** Removes leftovers of earlier runs that were killed hard (SIGKILL, crashed machine). */
function sweepStaleDirs(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('xo-e2e-')) continue;
    const p = join(tmpdir(), name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
    } catch { /* gone or not ours: leave it */ }
  }
}

/**
 * Builds the client (unless XO_E2E_SKIP_BUILD=1), creates a temp DB with one user through the real
 * setup function, and starts the real server on a free loopback port with the fake LLM. Exposes
 * XO_E2E_BASE_URL and XO_E2E_SECRET (the TOTP secret of the throw-away user) to the test workers.
 * The server and the temp directory are cleaned up on normal teardown, on exit, and on SIGTERM/SIGHUP/SIGINT.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env['XO_E2E_SKIP_BUILD'] !== '1') {
    const build = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('pnpm build failed');
  }
  sweepStaleDirs();

  const dir = mkdtempSync(join(tmpdir(), 'xo-e2e-')); // mode 0700
  let server: ChildProcess | undefined;
  const cleanupSync = (): void => {
    if (server && server.exitCode === null) server.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    cleanupSync();
    process.exit(128 + (sig === 'SIGTERM' ? 15 : sig === 'SIGHUP' ? 1 : 2));
  };
  process.on('exit', cleanupSync);
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, onSignal);

  try {
    const dbPath = join(dir, 'xo.db');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

    const secret = generateSecret();
    const db = openDb(dbPath);
    migrate(db);
    // setupUser consumes the confirming code's TOTP step, so confirm with the PREVIOUS step's code
    // (inside the +-1 window); the test then logs in with the current one.
    const previous = new Date(Date.now() - 30_000);
    await setupUser(db, { password: E2E_PASSWORD, secret, code: totpAt(secret, previous), now: previous });
    db.close();

    // Explicit, minimal environment: no .env file, no inherited OPENROUTER_* values, and a key file
    // path that does not exist, so the server can never reach OpenRouter or read the real key file.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      XO_DB_PATH: dbPath,
      XO_HOST: '127.0.0.1',
      XO_PORT: String(port),
      XO_PUBLIC_ORIGIN: base,
      XO_COOKIE_INSECURE: 'true',
      XO_LLM: 'fake',
      OPENROUTER_API_KEY: '',
      OPENROUTER_KEY_FILE: join(dir, 'no-such-key-file'),
    };
    const child = spawn(process.execPath, ['src/server/main.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server = child;
    let output = '';
    const collect = (b: Buffer): void => { output = (output + b.toString()).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    await waitForHealth(base, child, () => output);

    process.env['XO_E2E_BASE_URL'] = base;
    process.env['XO_E2E_SECRET'] = secret;
    process.env['XO_E2E_PASSWORD'] = E2E_PASSWORD;

    return async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((r) => {
          const t = setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000);
          child.once('exit', () => { clearTimeout(t); r(); });
        });
      }
      rmSync(dir, { recursive: true, force: true });
    };
  } catch (err) {
    cleanupSync();
    throw err;
  }
}
