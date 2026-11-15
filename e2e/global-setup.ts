import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createSession, sessionCookieName } from '../src/server/auth/sessions.ts';
import { generateSecret, totpAt } from '../src/server/auth/totp.ts';
import { setupUser } from '../src/server/cli/setup.ts';
import { loadConfig } from '../src/server/config.ts';
import { migrate } from '../src/server/db/migrate.ts';
import { openDb } from '../src/server/db/open.ts';

export const E2E_PASSWORD = 'correct horse battery';
/** Sessions created directly in the temp DB: one shared by most specs, spares for tests that log out or kill it. */
export const SPARE_SESSIONS = 4;
export const TOTP_STEP_MS = 30_000;

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
 * Builds the client into <tmp>/client (`vite build --mode e2e --outDir …`, so parallel runs and `pnpm build`
 * never disturb each other; the e2e mode adds the test-only #/kit document), creates a temp DB with one user
 * through the real setup function, creates sessions directly in that DB, and starts e2e/server.ts on a free
 * loopback port with the fake LLM. Exposes to the workers: XO_E2E_BASE_URL, XO_E2E_SECRET, XO_E2E_PASSWORD,
 * XO_E2E_STATE_DIR (storage state files `shared.json`, `spare-1.json` …, and `totp-last`).
 * `XO_E2E_SKIP_BUILD=1` serves ./dist/client instead (a production build has no #/kit; that test skips).
 * The server and the temp directory are cleaned up on teardown, on exit, and on SIGTERM/SIGHUP/SIGINT.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
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
    let clientDir = join(ROOT, 'dist', 'client');
    if (process.env['XO_E2E_SKIP_BUILD'] !== '1') {
      clientDir = join(dir, 'client');
      const vite = join(ROOT, 'node_modules', '.bin', 'vite');
      const build = spawnSync(vite, ['build', '--mode', 'e2e', '--outDir', clientDir, '--emptyOutDir'], { cwd: ROOT, stdio: 'inherit' });
      if (build.status !== 0) throw new Error('vite build failed');
    }

    const dbPath = join(dir, 'xo.db');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;

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
      XO_E2E_CLIENT_DIR: clientDir,
    };

    const secret = generateSecret();
    const db = openDb(dbPath);
    migrate(db);
    // setupUser consumes the confirming code's TOTP step, so confirm with the PREVIOUS step's code
    // (inside the +-1 window). Specs that need a login take later steps with nextTotpCode() (helpers.ts),
    // which reads the last used step from `totp-last`.
    const previous = new Date(Date.now() - TOTP_STEP_MS);
    await setupUser(db, { password: E2E_PASSWORD, secret, code: totpAt(secret, previous), now: previous });

    // Sessions straight into the temp DB (test-only): specs start logged in, with no TOTP code.
    const { config } = loadConfig(env);
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const names = ['shared', ...Array.from({ length: SPARE_SESSIONS }, (_, i) => `spare-${i + 1}`)];
    const expires = Math.floor(Date.now() / 1000) + 24 * 3600;
    for (const name of names) {
      const { token } = createSession(db, config, new Date());
      writeFileSync(join(stateDir, `${name}.json`), JSON.stringify({
        cookies: [{
          name: sessionCookieName(config), value: token, domain: '127.0.0.1', path: '/',
          expires, httpOnly: true, secure: false, sameSite: 'Strict',
        }],
        origins: [],
      }), { mode: 0o600 });
    }
    writeFileSync(join(stateDir, 'totp-last'), String(Math.floor(previous.getTime() / TOTP_STEP_MS)));
    db.close();

    const child = spawn(process.execPath, ['e2e/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server = child;
    let output = '';
    const collect = (b: Buffer): void => { output = (output + b.toString()).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    await waitForHealth(base, child, () => output);

    process.env['XO_E2E_BASE_URL'] = base;
    process.env['XO_E2E_SECRET'] = secret;
    process.env['XO_E2E_PASSWORD'] = E2E_PASSWORD;
    process.env['XO_E2E_STATE_DIR'] = stateDir;

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
