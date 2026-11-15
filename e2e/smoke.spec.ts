import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { totpAt } from '../src/server/auth/totp.ts';

// Keyboard-only smoke test of the built app (server: XO_LLM=fake, temp DB, user from global-setup).
// One ordered flow in one browser session. Mouse events are counted and must stay at zero.
//
// Focus rule (Chat): the input is focused (INSERT) after every submit and answer; a question is
// answered only after Esc (NORMAL), then its option key.

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: process.env['XO_E2E_BASE_URL'] });

const PASSWORD = process.env['XO_E2E_PASSWORD'] ?? '';
const SECRET = process.env['XO_E2E_SECRET'] ?? '';

let context: BrowserContext;
let page: Page;
const errors: string[] = [];
const voiceRequests: string[] = [];
/** The only console error a correct run may produce: the browser's note about the deliberate 401. */
const EXPECTED_401 = /^console: Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/;

/** Codes: login #1 uses the current step; later logins use a later step (+-1 window accepts it), since a used step is rejected. */
let loginOffset = 0;
const nextCode = (): string => {
  const code = totpAt(SECRET, new Date(Date.now() + loginOffset * 30_000));
  loginOffset = Math.max(loginOffset, 0) + 1;
  return code;
};

const mode = () => page.locator('.mode');
const selectedRow = () => page.locator('[role=log] .row.selected');
const chatInput = () => page.getByLabel('Chat input');
const flash = () => page.locator('[role=status].flash');

/** Types into the single-line overlay input (prompt, palette, picker) once it really has focus. */
async function typeInOverlay(text: string): Promise<void> {
  const input = page.locator('[role=dialog] input').first();
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function submit(text: string): Promise<void> {
  await expect(chatInput()).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

async function normalMode(): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(mode()).toHaveText('NORMAL');
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const s = await fetch('/api/auth/session');
      const csrf = s.ok ? ((await s.json()) as { csrfToken: string }).csrfToken : '';
      const r = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-xo-csrf': csrf },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: r.status === 204 ? null : await r.json() };
    },
    { method, path, body },
  ) as Promise<{ status: number; json: T }>;
}

async function logInWithKeyboard(): Promise<void> {
  const password = page.locator('input[type=password]');
  await expect(password).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter'); // moves to the code field
  await expect(page.locator('input[autocomplete=one-time-code]')).toBeFocused();
  await page.keyboard.type(nextCode());
  await page.keyboard.press('Enter');
}

test.beforeAll(async ({ browser }) => {
  expect(SECRET, 'global-setup did not run').not.toBe('');
  context = await browser.newContext({ viewport: { width: 1200, height: 800 }, permissions: ['microphone'] });
  // Count real mouse input: the flows below must never need it. (A click with detail 0 is the browser's
  // own keyboard activation, e.g. Enter submitting the login form, so it is not counted.)
  await context.addInitScript(() => {
    const w = window as unknown as { __mouse: number };
    w.__mouse = 0;
    (window as unknown as { __csp: string[] }).__csp = [];
    window.addEventListener('securitypolicyviolation', (e) => { (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`); }, true);
    for (const t of ['mousedown', 'click']) window.addEventListener(t, (e) => { if (e.isTrusted && (e as MouseEvent).detail > 0) w.__mouse++; }, true);
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('request', (r) => { if (r.url().includes('/api/voice/transcribe')) voiceRequests.push(r.method()); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
});

test.afterAll(async () => {
  await context?.close();
});

test('log in with the keyboard', async () => {
  await page.goto('/');
  await logInWithKeyboard();
  await expect(chatInput()).toBeFocused();
  await expect(mode()).toHaveText('INSERT');
  // The CSRF token and session live in memory/cookie only.
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).toBe('{}{}');
});

test('chat: prefix capture, undo, confident capture, unsure -> t, unknown person -> c', async () => {
  await submit('/todo call the bank');
  await expect(selectedRow()).toContainText('Action (me): call the bank');
  await expect(selectedRow()).toContainText('[u] undo');
  await expect(chatInput()).toBeFocused();

  await normalMode();
  await page.keyboard.press('u');
  await expect(selectedRow()).toContainText('(deleted)');
  await expect(flash()).toContainText('Undone');
  expect(((await api<{ actions: unknown[] }>('GET', '/api/actions?status=open')).json).actions).toHaveLength(0);

  await page.keyboard.press('i');
  await submit('remember the board deck');
  await expect(selectedRow()).toContainText('→ Note');
  await expect(selectedRow()).toContainText('[u] undo');
  await expect(selectedRow()).toContainText('remember the board deck');

  // Unsure: the fake classifier answers 0.1 for "??". Nothing is filed until the user picks.
  await submit('maybe this?? thing');
  await expect(selectedRow()).toContainText('What is this?');
  await expect(selectedRow()).toContainText('Esc, then press a key');
  await expect(chatInput()).toBeFocused(); // the question did not steal focus
  await normalMode();
  await page.keyboard.press('t');
  await expect(selectedRow()).toContainText('Action (me): maybe this?? thing');
  await expect(chatInput()).toBeFocused();

  // Unknown person: asks before creating.
  await submit('/note lunch with @Zed');
  await expect(selectedRow()).toContainText('Unknown person "Zed"');
  await normalMode();
  await page.keyboard.press('c');
  await expect(selectedRow()).toContainText('Zed (new)');
  await expect(chatInput()).toBeFocused();
});

test('people, agenda capture, and starting a 1-1 from the palette', async () => {
  await normalMode();
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page.locator('main')).toContainText('Zed');
  await page.keyboard.press('a');
  await typeInOverlay('Anna');
  await expect(page.locator('main')).toContainText('Anna');

  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await submit('/agenda @Anna hiring plan');
  await expect(selectedRow()).toContainText('Anna hiring plan');

  await normalMode();
  await page.keyboard.press(':');
  await typeInOverlay('start 1-1'); // first match: "Start 1-1 with…"
  await typeInOverlay('anna'); // person picker
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  await expect(page.locator('main')).toContainText('In progress');
  await expect(page.locator('main')).toContainText('[ ] Anna hiring plan');
});

test('1-1: add item, check off, follow-ups, notes autosave, end, next 1-1 carries over', async () => {
  await page.keyboard.press('a');
  await typeInOverlay('budget review');
  await expect(page.locator('main')).toContainText('[ ] budget review');

  await page.keyboard.press('g');
  await page.keyboard.press('g');
  await page.keyboard.press('x');
  await expect(page.locator('main')).toContainText('[x] Anna hiring plan');
  await expect(page.locator('main')).toContainText('[ ] budget review');

  await page.keyboard.press('t');
  await typeInOverlay('send offer letter');
  await expect(page.locator('main')).toContainText('(me) send offer letter');
  await page.keyboard.press('Shift+T');
  await typeInOverlay('draft hiring brief');
  await expect(page.locator('main')).toContainText('(them) draft hiring brief');

  const meetingId = (await page.evaluate(() => location.hash)).split('/')[2]!;
  await page.keyboard.press('n');
  await expect(page.getByLabel('Meeting notes')).toBeFocused();
  await page.keyboard.type('Discussed hiring. Anna owns the brief.');
  // Autosave while still typing (every few seconds), without leaving the field.
  await expect
    .poll(async () => ((await api<{ meeting: { notesMd: string } }>('GET', `/api/meetings/${meetingId}`)).json).meeting.notesMd, { timeout: 15_000 })
    .toContain('Discussed hiring. Anna owns the brief.');
  await expect(page.getByLabel('Meeting notes')).toBeFocused();
  await normalMode();

  await page.keyboard.press('Shift+E');
  await expect(page.getByRole('dialog', { name: 'End this 1-1' })).toBeVisible();
  await page.keyboard.press('y');
  await expect(page.locator('main')).toContainText('Ended');
  await expect(page.locator('textarea')).toHaveCount(0); // read-only now

  await page.keyboard.press('Escape'); // back to the person
  await expect(page).toHaveURL(/#\/people\/\d+$/);
  await expect(page.locator('main')).toContainText('Past meetings');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  await expect(page).not.toHaveURL(new RegExp(`#/meetings/${meetingId}$`));
  const main = page.locator('main');
  await expect(main).toContainText('In progress');
  await expect(main).toContainText('[ ] budget review'); // carried over
  await expect(main).not.toContainText('[ ] Anna hiring plan');
  await expect(main).toContainText('Discussed hiring. Anna owns the brief.'); // previous notes
  await expect(main).toContainText('[x] Anna hiring plan'); // previous resolved item
  await expect(main).toContainText('(me) send offer letter');
  await expect(main).toContainText('(them) draft hiring brief');
});

test('search finds the note, help overlay opens', async () => {
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search')).toBeFocused();
  await page.keyboard.type('board deck');
  await page.keyboard.press('Enter'); // search now and leave the input
  await expect(page.locator('main')).toContainText('[note]');
  await expect(page.locator('main')).toContainText('remember the board deck');
  await page.keyboard.press('Enter'); // open the selected result
  await expect(page).toHaveURL(/#\/notes\/\d+$/);
  await expect(page.locator('main textarea')).toHaveValue(/remember the board deck/); // body is an editor

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('go to chat');
  await expect(help).toContainText('command palette');
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

test('a 401 while typing keeps the draft and it is saved after logging in again', async () => {
  // The person's active 1-1 (started above) is where we type.
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await page.keyboard.press('Enter'); // first person in the list: Anna
  await expect(page).toHaveURL(/#\/people\/\d+$/);
  await expect(page.locator('main')).toContainText('Past meetings'); // loaded: keys are live
  await expect(page.locator('main')).toContainText('Anna');
  await page.keyboard.press('s'); // resumes the active 1-1
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  await expect(page.locator('main')).toContainText('In progress'); // loaded: keys are live
  const meetingId = (await page.evaluate(() => location.hash)).split('/')[2]!;

  await page.keyboard.press('n');
  await expect(page.getByLabel('Meeting notes')).toBeFocused();
  await page.keyboard.type('Draft before the 401');
  await context.clearCookies(); // the session disappears mid-typing
  await page.keyboard.type(' and more after it');
  // The next autosave gets a 401: the app locks and shows the login.
  await expect(page.locator('.lock')).toHaveCount(1, { timeout: 15_000 });
  // Nothing server-loaded stays behind the lock (hiding is not removing).
  await expect(page.locator('main textarea')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('budget review');

  await logInWithKeyboard();
  const notes = page.locator('main textarea');
  await expect(notes).toHaveValue('Draft before the 401 and more after it');
  await expect
    .poll(async () => ((await api<{ meeting: { notesMd: string } }>('GET', `/api/meetings/${meetingId}`)).json).meeting.notesMd, { timeout: 15_000 })
    .toBe('Draft before the 401 and more after it');
});

test('phone width (390px): chat fits, voice Send/Discard prompt is fully visible', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Escape'); // leave the notes field
  await expect(mode()).toHaveText('NORMAL');
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(chatInput()).toBeVisible();

  const fits = async (label: string): Promise<void> => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${label}: horizontal page overflow`).toBeLessThanOrEqual(0);
    for (const sel of ['.statusbar', '.prompt-line', '[role=log]']) {
      const box = await page.locator(sel).first().boundingBox();
      expect(box, `${label}: ${sel}`).not.toBeNull();
      expect(box!.x, `${label}: ${sel} left`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${label}: ${sel} right`).toBeLessThanOrEqual(390.5);
    }
  };
  await fits('chat');
  // The input line is usable at phone width: type and send.
  await page.keyboard.press('i');
  await submit('/note phone width check');
  await expect(selectedRow()).toContainText('phone width check');
  await fits('chat after capture');

  // Voice with the fake microphone: start from the palette (keyboard), let the fake clock run past the
  // 2-minute limit, and check that the Send/Discard prompt is completely inside the status line.
  await normalMode();
  await page.clock.install();
  await page.keyboard.press(':');
  await typeInOverlay('dictate');
  await expect(page.locator('.statusbar')).toContainText('REC');
  await page.clock.fastForward(121_000);
  const prompt = page.locator('.statusbar [role=alert]');
  await expect(prompt).toContainText('Recording reached 2 min');
  const bar = (await page.locator('.statusbar').boundingBox())!;
  for (const name of [/^Send/, /^Discard/]) {
    const b = await page.locator('.statusbar').getByRole('button', { name }).boundingBox();
    expect(b, `${name} button is rendered`).not.toBeNull();
    expect(b!.x, `${name} left edge`).toBeGreaterThanOrEqual(bar.x);
    expect(b!.x + b!.width, `${name} right edge inside the status line`).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
    expect(b!.x + b!.width, `${name} right edge inside the viewport`).toBeLessThanOrEqual(390);
  }
  const promptBox = (await prompt.boundingBox())!;
  expect(promptBox.x + promptBox.width).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
  await page.keyboard.press('Escape'); // Discard
  await expect(prompt).toHaveCount(0);
  await page.clock.runFor(1000);
  await page.waitForTimeout(500);
  expect(voiceRequests, 'a discarded recording must never be uploaded').toEqual([]);
  await page.setViewportSize({ width: 1200, height: 800 });
});

test('log out with the palette, and nothing needed the mouse', async () => {
  await normalMode();
  await page.keyboard.press(':');
  await typeInOverlay('log out');
  await expect(page.locator('input[type=password]')).toBeVisible();
  expect((await page.request.get('/api/auth/session')).status()).toBe(401);
  // Logout wipes what the user typed too; the old tab shows only the login.
  await expect(page.locator('main')).toHaveCount(0);

  expect(await page.evaluate(() => (window as unknown as { __mouse: number }).__mouse)).toBe(0);
  // Only the expected 401 console note(s) from the deliberate session loss; no page errors, no other errors.
  expect(errors.filter((e) => !EXPECTED_401.test(e))).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp), 'CSP violations').toEqual([]);
});
