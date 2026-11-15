import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

// The smoke test drives the real built app (see e2e/global-setup.ts): a temp DB, XO_LLM=fake, a user
// created through the setup function, a free port on 127.0.0.1. Nothing here touches OpenRouter.

function cacheDir(): string {
  const fromEnv = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (fromEnv && fromEnv !== '0') return fromEnv;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env['LOCALAPPDATA'] ?? homedir(), 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright');
}

/** Highest-revision `chrome-headless-shell` binary found in the shared Playwright cache. */
function cachedHeadlessShell(): { path: string; revision: number } | undefined {
  const root = cacheDir();
  let best: { path: string; revision: number } | undefined;
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return undefined; }
  for (const name of entries) {
    const m = /^chromium_headless_shell-(\d+)$/.exec(name);
    if (!m) continue;
    const revision = Number(m[1]);
    let sub: string | undefined;
    try { sub = readdirSync(join(root, name)).find((d) => d.startsWith('chrome-headless-shell-')); } catch { continue; }
    if (!sub) continue;
    const bin = join(root, name, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
    if (existsSync(bin) && (!best || revision > best.revision)) best = { path: bin, revision };
  }
  return best;
}

/**
 * Which Chromium to launch. Order: $XO_E2E_CHROMIUM (a path to a chrome / chrome-headless-shell
 * binary), then the browser Playwright installed for this version, then the newest
 * chrome-headless-shell in the shared Playwright cache (a version mismatch is reported). Undefined lets
 * Playwright report that the browser is missing ("pnpm exec playwright install chromium"). The choice is
 * logged once (the config is loaded again in every worker; the env flag keeps that quiet).
 */
function chromiumPath(): string | undefined {
  const say = (msg: string): void => {
    if (process.env['XO_E2E_BROWSER_LOGGED'] !== '1') console.log(`[e2e] ${msg}`);
  };
  let chosen: string | undefined;
  const fromEnv = process.env['XO_E2E_CHROMIUM'];
  if (fromEnv) {
    say(`browser: ${fromEnv} (XO_E2E_CHROMIUM)`);
    chosen = fromEnv;
  } else if (existsSync(chromium.executablePath())) {
    say(`browser: Playwright's bundled chromium (${chromium.executablePath()})`);
  } else {
    const cached = cachedHeadlessShell();
    if (cached) {
      const wanted = /chromium-(\d+)/.exec(chromium.executablePath())?.[1];
      say(`browser: cached chrome-headless-shell r${cached.revision} (${cached.path})`);
      if (wanted && Number(wanted) !== cached.revision) {
        say(`WARNING: this Playwright expects chromium r${wanted}; r${cached.revision} may behave differently. Run "pnpm exec playwright install chromium" to get the matching one.`);
      }
      chosen = cached.path;
    } else {
      say('WARNING: no chromium found. Run "pnpm exec playwright install chromium" or set XO_E2E_CHROMIUM.');
    }
  }
  process.env['XO_E2E_BROWSER_LOGGED'] = '1';
  return chosen;
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // One server, one user, one browser session: the spec is a single ordered flow.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'off',
    launchOptions: {
      executablePath: chromiumPath(),
      // Fake microphone for the voice check; no permission prompt.
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
