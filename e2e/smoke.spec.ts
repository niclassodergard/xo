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

test('arrow keys: view cycle, panes, answer options, capture selection, history recall', async () => {
  const focusedPane = () => page.locator('main .pane.focused .pane-title');

  // In a text field arrows are the caret's: nothing navigates.
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(chatInput()).toBeFocused();
  await expect(selectedRow()).toContainText('Anna hiring plan'); // loaded
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/#\/chat$/);

  // Global: step through Chat, Actions, Notes, People, wrapping.
  await normalMode();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/actions$/);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/notes$/);
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/people$/);
  await page.keyboard.press('ArrowLeft');
  await expect(page).toHaveURL(/#\/notes$/);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // wraps to Chat
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(chatInput()).toBeFocused();
  await normalMode();
  await page.keyboard.press('ArrowLeft'); // wraps to People
  await expect(page).toHaveURL(/#\/people$/);

  // Person and 1-1: previous/next pane instead of the view switch.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/people\/\d+$/);
  await expect(page.locator('main')).toContainText('Past meetings'); // loaded
  await expect(focusedPane()).toContainText('Agenda');
  await page.keyboard.press('ArrowRight');
  await expect(focusedPane()).toContainText('Open actions');
  await page.keyboard.press('ArrowLeft');
  await expect(focusedPane()).toContainText('Agenda');
  await page.keyboard.press('s');
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  await expect(page.locator('main')).toContainText('In progress');
  await expect(focusedPane()).toContainText('Agenda');
  await page.keyboard.press('ArrowRight');
  await expect(focusedPane()).toContainText('Follow-ups');
  await page.keyboard.press('ArrowLeft');
  await expect(focusedPane()).toContainText('Agenda');
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);

  // Chat: history recall is Alt-Up/Down; plain Up in an empty input selects the newest capture.
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(chatInput()).toBeFocused();
  await expect(selectedRow()).toContainText('Anna hiring plan');
  await page.keyboard.type('abc');
  await page.keyboard.press('ArrowUp'); // non-empty: native caret, no mode change, no recall
  await expect(chatInput()).toBeFocused();
  await expect(chatInput()).toHaveValue('abc');
  await page.keyboard.press('Alt+ArrowUp'); // recall works over typed text...
  await expect(chatInput()).toHaveValue('/agenda @Anna hiring plan');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(chatInput()).toHaveValue('/note lunch with @Zed');
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowDown'); // ...and typed text comes back
  await expect(chatInput()).toHaveValue('abc');
  await page.fill('[aria-label="Chat input"]', '');
  await page.keyboard.press('Alt+ArrowUp'); // recall from an empty input too
  await expect(chatInput()).toHaveValue('/agenda @Anna hiring plan');
  await page.fill('[aria-label="Chat input"]', '');

  await page.keyboard.press('ArrowUp'); // empty input: leave it, select the newest capture
  await expect(mode()).toHaveText('NORMAL');
  await expect(chatInput()).not.toBeFocused();
  await expect(selectedRow()).toContainText('Anna hiring plan');
  await page.keyboard.press('ArrowUp');
  await expect(selectedRow()).toContainText('Zed');
  await page.keyboard.press('ArrowDown');
  await expect(selectedRow()).toContainText('Anna hiring plan');
  await page.keyboard.press('ArrowDown'); // past the newest: back to the input
  await expect(chatInput()).toBeFocused();
  await expect(mode()).toHaveText('INSERT');

  // Selecting a pending capture makes its question live.
  await submit('first thing?? maybe');
  await expect(selectedRow()).toContainText('first thing?? maybe');
  await submit('second thing?? maybe');
  await expect(selectedRow()).toContainText('second thing?? maybe');
  await page.keyboard.press('ArrowUp');
  await expect(selectedRow()).toContainText('second thing?? maybe');
  await page.keyboard.press('ArrowUp');
  await expect(selectedRow()).toContainText('first thing?? maybe');
  await expect(selectedRow()).toContainText('Esc, then press a key'); // live on the selected capture

  // Answer options: Left/Right highlight, Enter picks; nothing changes the view.
  const highlighted = () => page.locator('[role=log] button.tbtn[aria-current=true]');
  await expect(highlighted()).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(highlighted()).toHaveCount(1);
  await expect(highlighted()).toContainText('[n]');
  await page.keyboard.press('ArrowRight');
  await expect(highlighted()).toContainText('[t]');
  await page.keyboard.press('ArrowLeft');
  await expect(highlighted()).toContainText('[n]');
  await expect(page).toHaveURL(/#\/chat$/);
  await page.keyboard.press('Enter');
  await expect(selectedRow()).toContainText('→ Note');
  await expect(selectedRow()).toContainText('first thing?? maybe');
  await expect(chatInput()).toBeFocused();

  // The highlight is visual only: after k onto a filed capture, Enter opens that item and answers nothing.
  const answers: string[] = [];
  const onReq = (r: { method(): string; url(): string }) => { if (r.method() === 'POST' && /\/answer$/.test(r.url())) answers.push(r.url()); };
  page.on('request', onReq);
  await normalMode();
  await page.keyboard.press('ArrowDown'); // from the answered first capture to the pending second one
  await expect(selectedRow()).toContainText('second thing?? maybe');
  await page.keyboard.press('ArrowRight');
  await expect(highlighted()).toContainText('[n]');
  await expect(page.locator('.statusbar [role=status]')).toContainText('Answer: Note'); // announced
  await page.keyboard.press('k'); // onto the filed capture (the first one, now a note)
  await expect(selectedRow()).toContainText('first thing?? maybe');
  await expect(highlighted()).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/notes\/\d+$/);
  expect(answers, 'Enter on a filed capture must not answer the other question').toEqual([]);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(chatInput()).toBeFocused();
  await expect(selectedRow()).toContainText('second thing?? maybe');
  await normalMode();
  await page.keyboard.press('d'); // letters keep working
  await expect(selectedRow()).toContainText('discarded');
  await expect(chatInput()).toBeFocused();
  page.off('request', onReq);

  // A pending question and an overlay opened from the input: closing the overlay gives the input back, so
  // stray typing is text, not an answer.
  await submit('third thing?? maybe');
  await expect(selectedRow()).toContainText('What is this?');
  const answers2: string[] = [];
  const onReq2 = (r: { method(): string; url(): string }) => { if (r.method() === 'POST' && /\/answer$/.test(r.url())) answers2.push(r.url()); };
  page.on('request', onReq2);
  await page.keyboard.type('draft text');
  await page.keyboard.press('Control+k');
  await typeInOverlay('help');
  const help = page.getByRole('dialog', { name: 'Help' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Chat input');
  await expect(help).toBeFocused(); // no focusable child: the box itself holds focus
  const modeBefore = await mode().innerText();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.type('xyz'); // letters do not reach the hidden input either
  await expect(chatInput()).toHaveValue('draft text');
  await expect(mode()).toHaveText(modeBefore);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(chatInput()).toBeFocused();
  await expect(mode()).toHaveText('INSERT');
  await page.keyboard.type('n');
  await expect(chatInput()).toHaveValue('draft textn');
  await page.fill('[aria-label="Chat input"]', '');
  await page.keyboard.press('Control+k');
  await typeInOverlay('start 1-1'); // palette -> person picker
  await expect(page.getByRole('dialog', { name: 'Pick person' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(chatInput()).toBeFocused();
  await page.keyboard.type('n');
  await expect(chatInput()).toHaveValue('n');
  await page.fill('[aria-label="Chat input"]', '');
  expect(answers2, 'typing after an overlay must not answer the pending question').toEqual([]);
  page.off('request', onReq2);
  await normalMode();
  await page.keyboard.press('d'); // discard the third question
  await expect(selectedRow()).toContainText('discarded');
  await expect(chatInput()).toBeFocused();

  // Recall keeps what was typed: resend after a recall, leave Chat mid-recall, edit a recalled line.
  await submit('/todo resend me');
  await expect(selectedRow()).toContainText('resend me');
  await page.keyboard.type('keep me');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(chatInput()).toHaveValue('/todo resend me');
  await page.keyboard.press('Enter'); // sends the recalled line; the typed text comes back
  await expect(chatInput()).toHaveValue('keep me');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/#\/actions$/);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(selectedRow()).toContainText('resend me'); // history loaded
  await expect(chatInput()).toHaveValue('/todo resend me'); // draft survived the remount
  await page.keyboard.press('Alt+ArrowDown'); // stash survived too
  await expect(chatInput()).toHaveValue('keep me');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(chatInput()).toHaveValue('/todo resend me');
  await page.keyboard.type('!'); // editing the recalled line
  await expect(chatInput()).toHaveValue('/todo resend me!');
  await page.keyboard.press('Alt+ArrowUp');
  await expect(chatInput()).toHaveValue('/todo resend me');
  await page.keyboard.press('Alt+ArrowDown');
  await expect(chatInput()).toHaveValue('keep me'); // the stash was not overwritten by the edit
  await page.fill('[aria-label="Chat input"]', '');

  // No live question: Left/Right fall through to the view switch.
  await normalMode();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/#\/actions$/);
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

test('voice Send/Discard prompt with a chat draft: Enter sends the recording, not the draft', async () => {
  await normalMode(); // NORMAL on Chat (the previous test ended here)
  await page.keyboard.press('i');
  await expect(chatInput()).toBeFocused();
  const captureCalls: string[] = [];
  const voiceBefore = voiceRequests.length;
  const onReq = (r: { method(): string; url(): string }) => { if (r.method() === 'POST' && /\/api\/captures$/.test(r.url())) captureCalls.push(r.url()); };
  page.on('request', onReq);
  const prompt = page.locator('.statusbar [role=alert]');
  const startAndPassLimit = async (): Promise<void> => {
    await page.keyboard.type('my draft');
    await page.keyboard.press('Control+k');
    await typeInOverlay('dictate');
    await expect(chatInput()).toBeFocused(); // the palette gave focus back
    await expect(page.locator('.statusbar')).toContainText('REC');
    await page.clock.fastForward(121_000);
    await expect(prompt).toContainText('Recording reached 2 min');
    await expect(chatInput()).not.toBeFocused(); // blurred, so Enter/Esc reach the voice layer
    await expect(mode()).toHaveText('NORMAL');
  };

  // Enter = Send: one transcription upload, no capture, draft intact.
  await startAndPassLimit();
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => voiceRequests.length - voiceBefore).toBe(1);
  // The fake transcriber says "open Anna": a voice command, so the app leaves Chat. Come back; the draft is intact.
  await expect(page).toHaveURL(/#\/people\/\d+$/);
  expect(captureCalls, 'Enter at the prompt must not send the chat draft').toEqual([]);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(chatInput()).toBeFocused();
  await expect(chatInput()).toHaveValue('my draft');
  await page.fill('[aria-label="Chat input"]', '');

  // Esc = Discard: nothing uploaded, no capture, draft intact, input focused again.
  await startAndPassLimit();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(chatInput()).toBeFocused();
  await expect(chatInput()).toHaveValue('my draft');
  await page.waitForTimeout(300);
  expect(voiceRequests.length - voiceBefore, 'discard uploads nothing more').toBe(1);
  expect(captureCalls).toEqual([]);
  page.off('request', onReq);
  await page.fill('[aria-label="Chat input"]', '');
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
