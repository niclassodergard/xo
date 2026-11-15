import { join } from 'node:path';
import { request as pwRequest } from '@playwright/test';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';
import { api, EXPECTED_401, expect, loginWithKeyboard, mouseCount, noHorizontalOverflow, seedAction, seedNote, seedPerson, seedProject, sel, test } from './helpers.ts';

// Step E: one journey across the areas, by keyboard only (zero real mouse events), in light and in dark, and the same
// core path with touch at 390 px. The area specs check each document in depth; this one proves they work together:
// capture (person + project) -> open from the conversation -> Actions grouped by project -> pin -> 1-1 with the person's
// open actions across projects -> palette search (Swedish case folding) -> log out.
//
// Logging out kills a session, so the light journey runs in its own browser context and logs in with the keyboard first
// (it does not touch the shared session or the four spares, which other specs hold). The dark journey runs on the
// shared session and so ends without logging out; the logout is proven once, in the light run.

const run = Date.now() % 1_000_000;
const panel = (page: Page) => page.locator(sel.panel);
const composer = (page: Page) => page.locator(sel.composer);
const palette = (page: Page) => page.locator(sel.palette);
const pinned = (page: Page) => page.locator('#side-group-pinned a');
const recents = (page: Page) => page.locator('#side-group-recents a');

/** The same collectors as the shared fixture (helpers.ts), for a context made here. */
const COLLECTORS = `
  window.__mouse = 0;
  window.__csp = [];
  window.addEventListener('securitypolicyviolation', (e) => { window.__csp.push(e.violatedDirective + ' ' + e.blockedURI); }, true);
  for (const t of ['mousedown', 'click']) {
    window.addEventListener(t, (e) => { if (e.isTrusted && e.detail > 0) window.__mouse++; }, true);
  }
`;

const csp = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);

/** Highlight the palette option whose text matches, with Down presses only, and press Enter. */
async function chooseOption(page: Page, text: RegExp | string): Promise<void> {
  const option = palette(page).getByRole('option').filter({ hasText: text }).first();
  await expect(option).toBeVisible();
  for (let i = 0; i < 30 && (await option.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
}

async function viaPalette(page: Page, query: string, option: RegExp | string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(palette(page).getByRole('combobox')).toBeFocused();
  await page.keyboard.type(query);
  await chooseOption(page, option);
  await expect(palette(page)).toHaveCount(0);
}

/** Red, green, blue of a computed colour like "rgb(38, 38, 36)". */
async function colours(page: Page): Promise<{ bg: number[]; fg: number[] }> {
  return page.evaluate(() => {
    const parse = (c: string): number[] => (c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    const s = getComputedStyle(document.body);
    return { bg: parse(s.backgroundColor), fg: parse(s.color) };
  });
}
const sum = (c: number[]): number => c.reduce((a, b) => a + b, 0);

interface Names { anna: string; apollo: string; zephyr: string; note: string; token: string }

async function journey(page: Page, theme: 'light' | 'dark', names: Names, opts: { logout: boolean }): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await expect(composer(page)).toBeVisible();

  // The theme follows the system: the page background and text really are the dark or the light token.
  const c = await colours(page);
  if (theme === 'dark') { expect(sum(c.bg)).toBeLessThan(250); expect(sum(c.fg)).toBeGreaterThan(550); }
  else { expect(sum(c.bg)).toBeGreaterThan(650); expect(sum(c.fg)).toBeLessThan(250); }

  // Data the journey needs (through the API: the keyboard part starts at the conversation).
  const anna = await seedPerson(page, names.anna);
  const apollo = await seedProject(page, names.apollo);
  const zephyr = await seedProject(page, names.zephyr);
  await seedAction(page, `${names.token} zephyr wait`, { owner: 'them', personId: anna.id, projectId: zephyr.id });
  await seedAction(page, `${names.token} loose task`, { owner: 'me', personId: anna.id });
  await seedNote(page, `Möte i ÖSTERSUND${names.token} om budget`, { title: names.note });
  await page.reload(); // the stores (people, projects) load again with the seeds
  await expect(composer(page)).toBeVisible();

  // 1. Capture with a person and a project. Cmd-J focuses the composer; Enter sends.
  await page.keyboard.press('ControlOrMeta+j');
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type(`/todo ${names.token} send the deck #${names.apollo} @${names.anna}`);
  await page.keyboard.press('Enter');
  const turn = page.locator('article.turn[data-capture]', { hasText: `${names.token} send the deck` }).first();
  await expect(turn).toBeVisible();
  const reply = turn.locator('.msg.xo');
  await expect(reply).toContainText('Filed as a task for you');
  await expect(reply.getByRole('link', { name: names.anna })).toBeVisible();
  await expect(reply.getByRole('link', { name: names.apollo })).toBeVisible();
  await expect(composer(page)).toBeFocused();

  // 2. Open it from the conversation: Up enters the stream, the filed item defaults to Open, Enter runs it.
  await page.keyboard.press('ArrowUp');
  await expect(page.locator(sel.stream)).toBeFocused();
  await expect(turn.locator('.chip.highlighted')).toHaveText('Open');
  await page.keyboard.press('Enter');

  // 3. Actions, grouped by project: the new action sits under its project, the other project has its own group.
  await expect(panel(page).getByRole('heading', { name: 'Actions', level: 2 })).toBeVisible();
  const group = (title: string): Locator =>
    panel(page).locator('.work-group').filter({ has: page.locator('.work-group-title', { hasText: title }) });
  await expect(group(names.apollo).getByRole('option', { name: new RegExp(`${names.token} send the deck`) })).toBeVisible();
  await expect(group(names.zephyr).getByRole('option', { name: new RegExp(`${names.token} zephyr wait`) })).toBeVisible();
  await expect(group('No project').getByRole('option', { name: new RegExp(`${names.token} loose task`) })).toBeVisible();
  const titles = (await panel(page).locator('.work-group-title').allTextContents()).map((t) => t.trim());
  const mine = titles.filter((t) => t.includes(names.token) || t.includes(names.apollo) || t.includes(names.zephyr));
  expect(mine.map((t) => t.replace(/ \(.*\)$/, '')).filter((t) => t !== 'No project')).toEqual([names.apollo, names.zephyr].sort());

  // 4. Open the project through the palette (a user-initiated open, so it becomes a recent), pin it.
  await viaPalette(page, names.apollo.toLowerCase(), names.apollo);
  await expect(panel(page).getByRole('heading', { name: names.apollo, level: 2 })).toBeVisible();
  await expect(panel(page).getByRole('option', { name: new RegExp(`${names.token} send the deck`) })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('pin current');
  await expect(palette(page).getByRole('option', { name: 'Pin current' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(pinned(page).filter({ hasText: names.apollo })).toHaveCount(1);
  await expect(recents(page).filter({ hasText: names.apollo })).toHaveCount(1);
  expect((await api<{ pinned: { id: number }[] }>(page, 'GET', '/api/nav')).json.pinned.map((p) => p.id)).toContain(apollo.id);

  // Esc closes the document and gives the keyboard back to the composer.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(composer(page)).toBeFocused();

  // 5. The person's 1-1: the open actions of all their projects are in the meeting, grouped by project.
  await viaPalette(page, names.anna.toLowerCase(), names.anna);
  await expect(panel(page).getByRole('heading', { name: names.anna, level: 2 })).toBeVisible();
  // Start the 1-1 from the palette ("Start 1-1 with…"), no scripted focus: the picker is a combobox with arrows and Enter.
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('start 1-1');
  await page.keyboard.press('Enter');
  const picker = page.getByRole('dialog', { name: 'Pick person' });
  await expect(picker.getByRole('combobox')).toBeFocused();
  await page.keyboard.type(names.anna.toLowerCase());
  await expect(picker.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { name: `1-1 · ${names.anna}`, level: 2 })).toBeVisible();
  const others = panel(page).getByRole('region', { name: 'Open actions' });
  await expect(others.getByRole('heading', { level: 4 })).toHaveText([names.apollo, names.zephyr, 'No project']);
  await expect(others.getByRole('listbox', { name: `Open actions: ${names.apollo}` }).getByRole('option', { name: new RegExp(`${names.token} send the deck`) })).toBeVisible();
  await expect(others.getByRole('listbox', { name: `Open actions: ${names.zephyr}` }).getByRole('option', { name: new RegExp(`Them.*${names.token} zephyr wait`) })).toBeVisible();
  await expect(others.getByRole('listbox', { name: 'Open actions: No project' }).getByRole('option', { name: new RegExp(`${names.token} loose task`) })).toBeVisible();

  // 6. Search from the palette: a word in a note body, typed in lower case; the text never enters the address.
  const requests: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/search')) requests.push(`${r.method()} ${r.url()}`); });
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type(`östersund${names.token}`);
  await expect(palette(page).getByRole('option').filter({ hasText: names.note })).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((r) => r.startsWith('POST ') && !r.toLowerCase().includes('sund'))).toBe(true);
  await chooseOption(page, names.note);
  await expect(page).toHaveURL(/#\/notes\/\d+$/);
  expect(page.url().toLowerCase()).not.toContain('sund');
  await expect(panel(page).getByRole('textbox', { name: 'Note body' })).toHaveValue(`Möte i ÖSTERSUND${names.token} om budget`);

  // The whole journey used the keyboard only, and nothing broke the CSP.
  expect(await mouseCount(page)).toBe(0);
  expect(await csp(page)).toEqual([]);

  // Pins are server-wide, not per session: leave the shared sidebar as the other specs expect it.
  expect((await api(page, 'DELETE', `/api/nav/pins/project/${apollo.id}`)).status).toBe(204);

  if (!opts.logout) return;

  // 7. Log out through the palette: the login form replaces the shell and the server forgets the session. The session
  // cookie is replayed from a separate request context before (200) and after (401), so it is the server that dropped it.
  const session = (await page.context().cookies()).find((c) => c.name.endsWith('xo_session'));
  expect(session).toBeDefined();
  const replay = async (): Promise<number> => {
    const ctx = await pwRequest.newContext({ baseURL: process.env['XO_E2E_BASE_URL'], extraHTTPHeaders: { cookie: `${session!.name}=${session!.value}` } });
    try { return (await ctx.get('/api/people')).status(); } finally { await ctx.dispose(); }
  };
  expect(await replay()).toBe(200);
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('log out');
  await expect(palette(page).getByRole('option', { name: 'Log out' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(composer(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText(names.anna)).toHaveCount(0); // no server data left in the DOM
  const after = await page.evaluate(async () => (await fetch('/api/people')).status);
  expect(after).toBe(401);
  expect(await replay()).toBe(401);
  expect(await mouseCount(page)).toBe(0);
}

async function freshContext(browser: Browser, viewport: { width: number; height: number }, extra: { hasTouch?: boolean; shared?: boolean } = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: process.env['XO_E2E_BASE_URL'],
    viewport,
    hasTouch: extra.hasTouch ?? false,
    // The runner applies the project's `use` options (the shared session) to browser.newContext(), so a logged-out context
    // must ask for an empty state explicitly.
    storageState: extra.shared ? join(process.env['XO_E2E_STATE_DIR'] ?? '', 'shared.json') : { cookies: [], origins: [] },
  });
  await context.addInitScript(COLLECTORS);
  return context;
}

test.describe('the journey, keyboard only', () => {
  test('light: from keyboard login to log out', async ({ browser, diag }) => {
    diag.allow(EXPECTED_401);
    const context = await freshContext(browser, { width: 1280, height: 800 });
    try {
      const page = await context.newPage();
      diag.watch(page);
      await page.goto('/');
      await loginWithKeyboard(page);
      const tag = `flowl${run}`;
      await journey(page, 'light', { anna: `flowAnna${tag}`, apollo: `flowApollo${tag}`, zephyr: `flowZephyr${tag}`, note: `flowNote${tag}`, token: tag }, { logout: true });
    } finally {
      await context.close();
    }
  });

  test('dark: the same journey on the shared session', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const tag = `flowd${run}`;
    await journey(page, 'dark', { anna: `flowAnna${tag}`, apollo: `flowApollo${tag}`, zephyr: `flowZephyr${tag}`, note: `flowNote${tag}`, token: tag }, { logout: false });
  });
});

test.describe('phone width (390 px), touch', () => {
  /** Controls smaller than 44 px (Apple's minimum touch target) in either direction, collected for one final assertion. */
  const tooSmall = new Set<string>();
  async function expectTouchSized(label: string, loc: Locator): Promise<void> {
    await expect(loc.first(), label).toBeVisible();
    const boxes = await loc.evaluateAll((els) => els.map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
    expect(boxes.length, label).toBeGreaterThan(0);
    for (const b of boxes) if (b.w < 44 || b.h < 44) tooSmall.add(`${label} ${b.w}x${b.h}`);
  }

  /** Every visible control inside the panel, the drawer and any dialog, measured as it is (not a fixed list). Checkboxes
   *  are exempt: their label is the target and is measured as part of the row. */
  async function measureAll(page: Page, step: string): Promise<void> {
    const small = await page.evaluate(() => {
      const out: string[] = [];
      const roots = document.querySelectorAll('[data-region="panel"], nav[aria-label="Sidebar"], [role="dialog"]');
      let seen = 0;
      for (const root of roots) {
        for (const el of root.querySelectorAll<HTMLElement>('button, a, select, input:not([type=checkbox]), textarea, [role=option]')) {
          if (!el.checkVisibility()) continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          seen++;
          if (Math.round(r.width) < 44 || Math.round(r.height) < 44) {
            const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24);
            out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(r.width)}x${Math.round(r.height)}`);
          }
        }
      }
      return { out, seen };
    });
    expect(small.seen, `${step}: controls measured`).toBeGreaterThan(0);
    for (const t of small.out) tooSmall.add(`${step}: ${t}`);
  }

  test('capture, open the project, Back, drawer, Actions: one panel at a time, 44 px targets, nothing wider than the screen', async ({ browser, diag }) => {
    const context = await freshContext(browser, { width: 390, height: 844 }, { hasTouch: true, shared: true });
    try {
      const page = await context.newPage();
      diag.watch(page);
      await page.goto('/');
      await expect(composer(page)).toBeVisible();
      const tag = `flowp${run}`;
      const person = await seedPerson(page, `flowCy${tag}`);
      const project = await seedProject(page, `flowPhone${tag}`);
      await page.reload();
      await expect(composer(page)).toBeVisible();
      expect(await noHorizontalOverflow(page)).toBe(true);

      await expectTouchSized('menu button', page.getByRole('button', { name: 'Show sidebar' }));
      await expectTouchSized('mic button', page.locator(sel.mic));

      await composer(page).tap();
      await composer(page).fill(`/todo ${tag} call back #${project.title} @${person.name}`);
      await expectTouchSized('send button', page.getByRole('button', { name: 'Send', exact: true }));
      await page.getByRole('button', { name: 'Send', exact: true }).tap();
      const turn = page.locator('article.turn[data-capture]', { hasText: `${tag} call back` }).first();
      await expect(turn).toBeVisible();
      await expect(turn.locator('.msg.xo')).toContainText('Filed as a task for you');
      await expectTouchSized('reply chips', turn.locator('.chip'));
      expect(await noHorizontalOverflow(page)).toBe(true);

      // The project name is a link: one panel at a time, the composer is gone, Back returns to the conversation.
      await turn.locator('.msg.xo').getByRole('link', { name: project.title }).tap();
      await expect(panel(page).getByRole('heading', { name: project.title, level: 2 })).toBeVisible();
      await expect(composer(page)).toHaveCount(0);
      await expectTouchSized('Back', panel(page).getByRole('button', { name: 'Back' }));
      await expectTouchSized('Close', panel(page).getByRole('button', { name: 'Close document' }));
      expect(await noHorizontalOverflow(page)).toBe(true);
      await measureAll(page, 'project');

      // Pin from the project.
      await panel(page).getByRole('button', { name: 'Pin', exact: true }).tap();
      await expect(panel(page).getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();
      await measureAll(page, 'project pinned');
      expect((await api<{ pinned: { id: number }[] }>(page, 'GET', '/api/nav')).json.pinned.map((p) => p.id)).toContain(project.id);
      await panel(page).getByRole('button', { name: 'Unpin', exact: true }).tap(); // leave the shared sidebar as found
      await expect(panel(page).getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
      await panel(page).getByRole('button', { name: 'Back' }).tap();
      await expect(composer(page)).toBeVisible();
      await expect(panel(page)).toHaveCount(0);

      // Open the person from the reply, start a 1-1 by tap, open a Confirm and dismiss it.
      await turn.locator('.msg.xo').getByRole('link', { name: person.name }).tap();
      await expect(panel(page).getByRole('heading', { name: person.name, level: 2 })).toBeVisible();
      await measureAll(page, 'person');
      await panel(page).getByRole('button', { name: 'Start 1-1' }).tap();
      await expect(panel(page).getByRole('heading', { name: `1-1 · ${person.name}`, level: 2 })).toBeVisible();
      await measureAll(page, 'meeting');
      await panel(page).getByRole('button', { name: 'End meeting' }).tap();
      const confirm = page.getByRole('dialog', { name: 'Confirm' });
      await expect(confirm).toBeVisible();
      await measureAll(page, 'confirm');
      await confirm.getByRole('button', { name: 'No' }).tap();
      await expect(confirm).toHaveCount(0);
      await expect(panel(page).getByRole('button', { name: 'End meeting' })).toBeVisible(); // dismissed: still active
      await page.goto('/');
      await expect(composer(page)).toBeVisible();

      // The drawer: items are touch sized; opening Actions closes it and shows the grouped action.
      await page.getByRole('button', { name: 'Show sidebar' }).tap();
      const side = page.locator(sel.sidebar);
      await expect(side).toBeVisible();
      await expectTouchSized('drawer items', side.locator('a.side-item, button.side-item'));
      await measureAll(page, 'drawer');
      await side.getByRole('link', { name: 'Actions' }).tap();
      await expect(side).toBeHidden();
      await expect(panel(page).getByRole('heading', { name: 'Actions', level: 2 })).toBeVisible();
      const group = panel(page).locator('.work-group').filter({ has: page.locator('.work-group-title', { hasText: project.title }) });
      const row = group.getByRole('option', { name: new RegExp(`${tag} call back`) });
      await expect(row).toBeVisible();
      await expectTouchSized('action row', row);
      await measureAll(page, 'actions');
      expect(await noHorizontalOverflow(page)).toBe(true);

      await panel(page).getByRole('button', { name: 'Back' }).tap();
      await expect(composer(page)).toBeVisible();
      expect(await csp(page)).toEqual([]);
      expect([...tooSmall], 'touch targets under 44 px').toEqual([]);
    } finally {
      await context.close();
    }
  });
});
