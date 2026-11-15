import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { totpAt } from '../src/server/auth/totp.ts';
import type { Action, Note, Person, Project } from '../src/shared/types.ts';
import { TOTP_STEP_MS } from './global-setup.ts';

// Shared helpers for every e2e spec. All specs share one server, one DB and one conversation stream, so each
// spec prefixes the names it creates with its area (e.g. "shell Anna") and asserts only on those items.

const env = (name: string): string => process.env[name] ?? '';

export interface Diag {
  /** Console errors and uncaught page errors (minus the allowed ones, checked when the test ends). */
  errors: string[];
  /** Do not count console/page errors matching this (e.g. the browser's note about a deliberate 401). */
  allow(re: RegExp): void;
  /** Collect errors and CSP violations of another page (a spare session, a second context). */
  watch(page: Page): void;
}

interface Fixtures {
  diag: Diag;
  /** A new page logged in as spare session `n` (1..4), in its own context (closed after the test). */
  sparePage: (n: number) => Promise<Page>;
}

/** The browser's note about a deliberate 401 (a killed session). */
export const EXPECTED_401 = /Failed to load resource: the server responded with a status of 401/;

/** Counts real mouse input and CSP violations in every page of the context (before any script runs). */
const COLLECTORS = `
  window.__mouse = 0;
  window.__csp = [];
  window.addEventListener('securitypolicyviolation', (e) => { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); }, true);
  for (const t of ['mousedown', 'click']) {
    window.addEventListener(t, (e) => { if (e.isTrusted && e.detail > 0) window.__mouse++; }, true);
  }
`;

/**
 * The `test` for specs: every page starts logged in (shared session cookie from global-setup), has the mouse
 * and CSP collectors, and fails the test at the end on any console error, page error or CSP violation that
 * was not allowed with `diag.allow()`.
 */
export const test = base.extend<Fixtures>({
  baseURL: async ({}, use) => { await use(env('XO_E2E_BASE_URL')); },
  storageState: async ({}, use) => { await use(join(env('XO_E2E_STATE_DIR'), 'shared.json')); },
  context: async ({ context }, use) => {
    await context.addInitScript(COLLECTORS);
    await use(context);
  },
  diag: [async ({ page }, use) => {
    const errors: string[] = [];
    const allowed: RegExp[] = [];
    const pages: Page[] = [];
    const diag: Diag = {
      errors,
      allow: (re) => { allowed.push(re); },
      watch: (p) => {
        pages.push(p);
        p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        p.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
      },
    };
    diag.watch(page);
    await use(diag);
    const csp: string[] = [];
    for (const p of pages) csp.push(...await p.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []));
    expect(errors.filter((e) => !allowed.some((re) => re.test(e))), 'console / page errors').toEqual([]);
    expect(csp, 'CSP violations').toEqual([]);
  }, { auto: true }],
  sparePage: async ({ browser, diag }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (n) => {
      if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error(`no spare session ${n}`);
      const context = await browser.newContext({ baseURL: env('XO_E2E_BASE_URL'), storageState: join(env('XO_E2E_STATE_DIR'), `spare-${n}.json`) });
      await context.addInitScript(COLLECTORS);
      contexts.push(context);
      const page = await context.newPage();
      diag.watch(page);
      return page;
    });
    for (const c of contexts) await c.close();
  },
});

export { expect };

// ---- API and seeds -------------------------------------------------------------------------

/** Calls the API from inside the page (cookie + CSRF token as the app does). */
export async function api<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const s = await fetch('/api/auth/session');
      const csrf = s.ok ? ((await s.json()) as { csrfToken: string }).csrfToken : '';
      const r = await fetch(path, {
        method,
        // content-type only with a body: Fastify answers 400 to a bodiless PUT/DELETE that declares JSON.
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-xo-csrf': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: r.status === 204 ? null : await r.json() };
    },
    { method, path, body },
  ) as Promise<{ status: number; json: T }>;
}

async function created<T>(page: Page, path: string, body: unknown): Promise<T> {
  const r = await api<T>(page, 'POST', path, body);
  if (r.status !== 201) throw new Error(`POST ${path} answered ${r.status}`);
  return r.json;
}

/** The page must be on the app origin (page.goto('/') first) for these to work. */
export const seedPerson = (page: Page, name: string, aliases: string[] = []): Promise<Person> =>
  created<Person>(page, '/api/people', { name, aliases });
export const seedProject = (page: Page, title: string, extra: { aliases?: string[]; status?: 'active' | 'on_hold' | 'done'; descriptionMd?: string } = {}): Promise<Project> =>
  created<Project>(page, '/api/projects', { title, ...extra });
export const seedNote = (page: Page, bodyMd: string, extra: { title?: string; personId?: number | null; projectId?: number | null } = {}): Promise<Note> =>
  created<Note>(page, '/api/notes', { bodyMd, ...extra });
export const seedAction = (page: Page, text: string, extra: { owner?: 'me' | 'them'; personId?: number | null; projectId?: number | null } = {}): Promise<Action> =>
  created<Action>(page, '/api/actions', { text, ...extra });

// ---- selectors (stable accessibility names, plan 4.8) ---------------------------------------

export const sel = {
  sidebar: 'nav[aria-label="Sidebar"]',
  stream: '[role="log"][aria-label="Conversation"]',
  composer: 'textarea[aria-label="Message XO"]',
  panel: '[role="region"][aria-label="Document"]',
  palette: '[role="dialog"][aria-label="Search and commands"]',
  mic: 'button[aria-label^="Dictate"]',
} as const;

// ---- login ----------------------------------------------------------------------------------

/**
 * A TOTP code the server will accept and has not seen: the next step after the last one used (setup consumed
 * the previous step), waiting for the clock when that step is not yet inside the server's +-1 window.
 */
export async function nextTotpCode(): Promise<string> {
  const file = join(env('XO_E2E_STATE_DIR'), 'totp-last');
  for (;;) {
    const nowStep = Math.floor(Date.now() / TOTP_STEP_MS);
    const candidate = Math.max(Number(readFileSync(file, 'utf8')) + 1, nowStep - 1);
    if (candidate <= nowStep + 1) {
      writeFileSync(file, String(candidate));
      return totpAt(env('XO_E2E_SECRET'), new Date(candidate * TOTP_STEP_MS + TOTP_STEP_MS / 2));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Logs in on the Login screen with the keyboard only (password, Enter, code, Enter). */
export async function loginWithKeyboard(page: Page): Promise<void> {
  const password = page.locator('input[type=password]');
  await expect(password).toBeFocused();
  await page.keyboard.type(env('XO_E2E_PASSWORD'));
  await page.keyboard.press('Enter'); // moves to the code field
  await expect(page.locator('input[autocomplete=one-time-code]')).toBeFocused();
  await page.keyboard.type(await nextTotpCode());
  await page.keyboard.press('Enter');
}

// ---- diagnostics ----------------------------------------------------------------------------

/** Real mouse presses and clicks so far (a click with detail 0 is the browser's own keyboard activation). */
export const mouseCount = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __mouse?: number }).__mouse ?? 0);

/** Nothing on the page is wider than the viewport. */
export const noHorizontalOverflow = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
