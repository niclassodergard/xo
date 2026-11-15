import { join } from 'node:path';
import { api, EXPECTED_401, expect, loginWithKeyboard, noHorizontalOverflow, seedNote, seedPerson, seedProject, sel, test } from './helpers.ts';
import type { Page } from '@playwright/test';

// Browser check for step C2: sidebar Pinned and Recents, the pin command, and the search palette.
// Names carry the "nav" prefix and a per-run number; assertions look only at the items created here.

const run = Date.now() % 1_000_000;
const composer = (page: Page) => page.locator(sel.composer);
const panel = (page: Page) => page.locator(sel.panel);
const palette = (page: Page) => page.locator(sel.palette);
const recents = (page: Page) => page.locator('#side-group-recents a');
const pinned = (page: Page) => page.locator('#side-group-pinned a');

/** Titles of the links in a sidebar list that belong to this spec, in list order. */
async function mine(list: ReturnType<typeof recents>): Promise<string[]> {
  return (await list.locator('.side-label').allInnerTexts()).map((t) => t.trim()).filter((t) => t.startsWith('nav') && t.endsWith(String(run)));
}

/** Highlight the option whose text matches, with Down presses only, and press Enter. */
async function chooseOption(page: Page, text: RegExp | string): Promise<void> {
  const option = palette(page).getByRole('option').filter({ hasText: text }).first();
  await expect(option).toBeVisible();
  for (let i = 0; i < 30 && (await option.getAttribute('aria-selected')) !== 'true'; i++) await page.keyboard.press('ArrowDown');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
}

async function openViaPalette(page: Page, query: string, option: RegExp | string): Promise<void> {
  await page.keyboard.press('Meta+k');
  await expect(palette(page).getByRole('combobox')).toBeFocused();
  await page.keyboard.type(query);
  await chooseOption(page, option);
  await expect(palette(page)).toHaveCount(0);
}

test.describe('desktop', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
  });

  test('opened documents become recents, newest first, and survive a reload; a route load records nothing', async ({ page }) => {
    const person = await seedPerson(page, `navAnna${run}`);
    const project = await seedProject(page, `navApollo${run}`);
    const note = await seedNote(page, `navbody${run} text`, { title: `navNote${run}` });
    await page.reload();
    await expect(composer(page)).toBeVisible();

    const posts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/nav/recents')) posts.push(r.postData() ?? ''); });

    // Open them in a known order through the palette (user-initiated opens).
    await openViaPalette(page, person.name.toLowerCase(), person.name);
    await expect(page).toHaveURL(new RegExp(`#/people/${person.id}$`));
    await openViaPalette(page, project.title.toLowerCase(), project.title);
    await expect(page).toHaveURL(new RegExp(`#/projects/${project.id}$`));
    await openViaPalette(page, note.title.toLowerCase(), note.title);
    await expect(page).toHaveURL(new RegExp(`#/notes/${note.id}$`));

    await expect.poll(() => mine(recents(page))).toEqual([note.title, project.title, person.name]);
    expect(posts).toHaveLength(3);

    // Server-side: still there after a reload.
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect.poll(() => mine(recents(page))).toEqual([note.title, project.title, person.name]);

    // Clicking an older recent opens it and moves it to the top.
    await recents(page).filter({ hasText: person.name }).click();
    await expect(page).toHaveURL(new RegExp(`#/people/${person.id}$`));
    await expect.poll(() => mine(recents(page))).toEqual([person.name, note.title, project.title]);

    // Loading a document URL directly (or reloading on it) must not send a recents request.
    const before = posts.length;
    const sawNav = page.waitForResponse((r) => r.url().endsWith('/api/nav') && r.request().method() === 'GET');
    await page.goto(`/#/projects/${project.id}`);
    await page.reload();
    await sawNav;
    await expect(panel(page)).toBeVisible();
    await expect.poll(() => mine(recents(page))).toEqual([person.name, note.title, project.title]);
    expect(posts.length).toBe(before); // the loads sent no recents request
  });

  test('pin and unpin from the palette; a second browser context sees the same pins; collapse state is kept', async ({ page, browser, diag }) => {
    const project = await seedProject(page, `navPinned${run}`);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await openViaPalette(page, project.title.toLowerCase(), project.title);
    await expect(panel(page)).toBeVisible();

    await page.keyboard.press('Meta+k');
    await page.keyboard.type('pin current');
    await expect(palette(page).getByRole('option', { name: 'Pin current' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => mine(pinned(page))).toEqual([project.title]);

    // The same session in another context sees the pin (it is stored on the server).
    const other = await browser.newContext({ baseURL: process.env['XO_E2E_BASE_URL'], storageState: join(process.env['XO_E2E_STATE_DIR'] ?? '', 'shared.json') });
    const page2 = await other.newPage();
    diag.watch(page2);
    await page2.setViewportSize({ width: 1280, height: 800 });
    await page2.goto('/');
    await expect(composer(page2)).toBeVisible();
    await expect.poll(() => mine(pinned(page2))).toEqual([project.title]);
    await other.close();

    // The Pinned group collapses with its title button and stays collapsed after a reload.
    const side = page.locator(sel.sidebar);
    await side.getByRole('button', { name: 'Pinned' }).click();
    await expect(pinned(page)).toHaveCount(0);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(side.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-expanded', 'false');
    await side.getByRole('button', { name: 'Pinned' }).click();
    await expect.poll(() => mine(pinned(page))).toEqual([project.title]);

    // Unpin with the same command (its title flipped).
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('unpin current');
    await expect(palette(page).getByRole('option', { name: 'Unpin current' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => mine(pinned(page))).toEqual([]);
    expect((await api<{ pinned: unknown[] }>(page, 'GET', '/api/nav')).json.pinned.some((p) => (p as { id: number }).id === project.id)).toBe(false);
  });

  test('the palette finds a person by name and a note by body text (Swedish case folding), and the text never enters the URL', async ({ page }) => {
    const person = await seedPerson(page, `navÅsa${run}`);
    await seedNote(page, `Möte i ÖSTERSUND${run} om budget`, { title: `navÖ${run}` });
    await page.reload();
    await expect(composer(page)).toBeVisible();
    const urlBefore = page.url();

    // Person by name, typed in lower case.
    await page.keyboard.press('Meta+k');
    await page.keyboard.type(`navåsa${run}`);
    await expect(palette(page).getByRole('option', { name: new RegExp(person.name) })).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    await chooseOption(page, person.name);
    await expect(panel(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/people/${person.id}$`));

    // Note by a word in its body, typed in lower case; the hit comes from the server after the debounce.
    const requests: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/search')) requests.push(`${r.method()} ${r.url()}`); });
    await page.keyboard.press('Meta+k');
    await page.keyboard.type(`östersund${run}`);
    const hit = palette(page).getByRole('option').filter({ hasText: new RegExp(`navÖ${run}`) });
    await expect(hit).toBeVisible();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.startsWith('POST ') && !r.includes('sterSund') && !r.includes('sterssund') && !r.toLowerCase().includes('sund'))).toBe(true);
    await chooseOption(page, new RegExp(`navÖ${run}`));
    await expect(page).toHaveURL(/#\/notes\/\d+$/);
    expect(page.url()).not.toContain('sund');

    // One character does not start a server search.
    requests.length = 0;
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('ö');
    await page.waitForTimeout(500);
    expect(requests).toEqual([]);
    await page.keyboard.press('Escape');
  });

  test('a document opened from the palette with the keyboard is a recent after Esc closes it', async ({ page }) => {
    const person = await seedPerson(page, `navKey${run}`);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await openViaPalette(page, person.name.toLowerCase(), person.name);
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect.poll(() => mine(recents(page))).toContain(person.name);
  });
});

test.describe('phone width (390 px)', () => {
  test('the drawer shows Pinned and Recents', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    const project = await seedProject(page, `navPhone${run}`);
    expect((await api(page, 'PUT', `/api/nav/pins/project/${project.id}`)).status).toBe(204);
    expect((await api(page, 'POST', '/api/nav/recents', { kind: 'project', id: project.id })).status).toBe(204);
    await page.reload();
    await expect(composer(page)).toBeVisible();

    await page.getByRole('button', { name: 'Show sidebar' }).click();
    const side = page.locator(sel.sidebar);
    await expect(side).toBeVisible();
    await expect(side.getByRole('button', { name: 'Pinned' })).toBeVisible();
    await expect(side.getByRole('button', { name: 'Recents' })).toBeVisible();
    await expect.poll(() => mine(pinned(page))).toEqual([project.title]);
    await expect.poll(() => mine(recents(page))).toContain(project.title);
    expect(await noHorizontalOverflow(page)).toBe(true);

    // Opening one from the drawer closes it and shows the document.
    await recents(page).filter({ hasText: project.title }).click();
    await expect(side).toBeHidden();
    await expect(panel(page)).toBeVisible();
    await api(page, 'DELETE', `/api/nav/pins/project/${project.id}`);
  });
});

test.describe('session lock', () => {
  test('the drawer key layer does nothing behind the Login curtain', async ({ sparePage, diag }) => {
    diag.allow(EXPECTED_401);
    const page = await sparePage(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    const app = page.locator('.app');

    // With a session, Esc closes the open drawer (so the assertion below can tell the difference).
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(app).toHaveAttribute('data-sidebar', 'open');
    await page.keyboard.press('Escape');
    await expect(app).toHaveAttribute('data-sidebar', 'closed');

    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(app).toHaveAttribute('data-sidebar', 'open');
    await page.evaluate(async () => {
      const s = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-xo-csrf': s.csrfToken } });
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(app).toHaveAttribute('aria-hidden', 'true');

    for (const key of ['Escape', 'Meta+b', 'Control+b', 'Meta+j', 'Meta+n']) await page.keyboard.press(key);
    await expect(app).toHaveAttribute('data-sidebar', 'open'); // nothing moved behind the curtain
    await expect(page.locator('input[type=password]')).toBeVisible();

    await loginWithKeyboard(page);
    await expect(composer(page)).toBeVisible();
  });
});
