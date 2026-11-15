import { api, expect, EXPECTED_401, loginWithKeyboard, mouseCount, noHorizontalOverflow, seedPerson, seedProject, sel, test } from './helpers.ts';
import type { Locator, Page } from '@playwright/test';

// Browser check for step C3: the conversation stream and the composer (fake LLM). All specs share one stream, so
// every text carries the word "stream" and assertions look only at the turns this spec created.

const composer = (page: Page) => page.locator(sel.composer);
const turn = (page: Page, text: string) => page.locator('article.turn', { hasText: text });
const reply = (t: Locator) => t.locator('.msg.xo');

async function send(page: Page, text: string): Promise<Locator> {
  await composer(page).focus();
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
  // Only a landed turn (it has data-capture), never the queued placeholder.
  const t = page.locator('article.turn[data-capture]', { hasText: text.replace(/^\/\w+\s+/, '').replace(/^todo:\s*/, '') }).first();
  await expect(t).toBeVisible();
  await expect(t).toHaveAttribute('data-capture', /^[1-9]\d*$/);
  return t;
}

async function captureId(t: Locator): Promise<number> {
  return Number(await t.getAttribute('data-capture'));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(page.locator(sel.stream)).toBeVisible();
});

test('a task is filed with a reply; Up, Right to Undo, Enter undoes it (keyboard only)', async ({ page }) => {
  const sent = await send(page, '/todo stream call the bank');
  // The server redacts an undone capture (its text is gone), so follow the turn by its id from here on.
  const t = page.locator(`article.turn[data-capture="${await captureId(sent)}"]`);
  await expect(reply(t)).toContainText('Filed as a task for you');
  await expect(t.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(t.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(t.getByRole('button', { name: 'Reclassify' })).toBeVisible();
  await expect(composer(page)).toBeFocused();

  await page.keyboard.press('ArrowUp'); // empty composer: into the stream at the newest turn
  await expect(page.locator(sel.stream)).toBeFocused();
  await expect(t).toHaveClass(/selected/);
  await expect(t.locator('.chip.highlighted')).toHaveText('Open'); // a filed item defaults to Open
  await page.keyboard.press('ArrowRight');
  await expect(t.locator('.chip.highlighted')).toHaveText('Undo');
  await page.keyboard.press('Enter');
  await expect(reply(t)).toContainText('Undone');
  await expect(t.locator('.chip')).toHaveCount(0);
  await expect(composer(page)).toBeFocused(); // done with the item: the keyboard goes back to the composer
  expect(await mouseCount(page)).toBe(0);
});

test('a project suggested by the classifier asks; arrows and Enter answer it', async ({ page }) => {
  await seedProject(page, 'Streamalpha');
  const t = await send(page, 'todo: stream slides for project Streamalpha');
  await expect(reply(t)).toContainText('Which project is "Streamalpha"?');
  await expect(t.locator('.chip')).toHaveText(['Streamalpha', 'Skip (no project)', 'Discard']);

  await page.keyboard.press('ArrowUp');
  await expect(t).toHaveClass(/selected/);
  await expect(t.locator('.chip.highlighted')).toHaveCount(0); // a question has no default chip
  await page.keyboard.press('Enter');                          // nothing highlighted: nothing happens
  await expect(reply(t)).toContainText('Which project');
  await page.keyboard.press('ArrowRight');
  await expect(t.locator('.chip.highlighted')).toHaveText('Streamalpha');
  await page.keyboard.press('Enter');
  await expect(reply(t)).toContainText('Filed as a task for you · on Streamalpha');
  expect(await mouseCount(page)).toBe(0);
});

test('a kind question leaves the composer focused; typing more does not answer it', async ({ page }) => {
  const t = await send(page, 'stream is this a thing ??');
  await expect(reply(t)).toContainText('What is this?');
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type('nad dtn');
  await expect(composer(page)).toHaveValue('nad dtn');
  await expect(reply(t)).toContainText('What is this?'); // still waiting: letters answered nothing
  await expect(t.locator('.chip')).toHaveCount(5); // note, action, agenda, "Answer it", discard
  await composer(page).fill('');
  const r = await api(page, 'POST', `/api/captures/${await captureId(t)}/answer`, { key: 'd' });
  expect(r.status).toBe(200);
});

test('an unknown @name asks before creating; Create files with a new person', async ({ page }) => {
  const t = await send(page, '/todo stream call @Streamzed');
  await expect(reply(t)).toContainText('"Streamzed"');
  await expect(t.locator('.chip')).toHaveText(['Create person "Streamzed"', 'Pick existing person', 'Skip (no person)', 'Discard']);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(reply(t)).toContainText('Filed as a task for you · Streamzed (new)');
  await expect(reply(t).getByRole('link', { name: /Streamzed/ })).toBeVisible();
});

test('#project forces the project and a name is a link that opens the panel', async ({ page }) => {
  const project = await seedProject(page, 'Streambeta');
  const t = await send(page, '/note stream pointer for #streambeta');
  await expect(reply(t)).toContainText('Saved as a note · on Streambeta');
  await reply(t).getByRole('link', { name: 'Streambeta' }).click();
  await expect(page.locator(sel.panel)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/projects/${project.id}$`));
});

test('a person is linked by name in the reply', async ({ page }) => {
  const person = await seedPerson(page, 'Streamanna');
  await page.reload();
  await expect(composer(page)).toBeVisible();
  const t = await send(page, '/wait stream budget from @Streamanna');
  await expect(reply(t)).toContainText('Waiting on Streamanna for this');
  await reply(t).getByRole('link', { name: 'Streamanna' }).click();
  await expect(page).toHaveURL(new RegExp(`#/people/${person.id}$`));
});

test('submits typed while the first page of the stream is still loading are kept', async ({ page }) => {
  // The initial GET /api/captures answers late: both sends must still show, in order, after it lands.
  await page.route('**/api/captures?**', async (route) => {
    if (route.request().method() === 'GET') await new Promise((r) => setTimeout(r, 800));
    await route.continue();
  });
  const started = Date.now();
  const loaded = page.waitForResponse((r) => r.url().includes('/api/captures?') && r.request().method() === 'GET');
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await composer(page).focus();
  await page.keyboard.type('/note stream slowload one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/note stream slowload two');
  await page.keyboard.press('Enter');
  await loaded;
  expect(Date.now() - started).toBeGreaterThanOrEqual(800); // the delay really applied
  await expect(turn(page, 'stream slowload one').first()).toBeVisible();
  await expect(turn(page, 'stream slowload two').first()).toBeVisible();
  const texts = await page.locator('article.turn .msg.user .msg-text').allTextContents();
  const one = texts.findIndex((x) => x.includes('stream slowload one'));
  expect(one).toBeGreaterThanOrEqual(0);
  expect(texts.findIndex((x) => x.includes('stream slowload two'))).toBeGreaterThan(one);
  await expect(page.locator('article.turn.queued')).toHaveCount(0);
});

test('two fast submits both land, in order', async ({ page }) => {
  await page.waitForLoadState('networkidle');
  await composer(page).focus();
  await page.keyboard.type('/note stream fast one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/note stream fast two');
  await page.keyboard.press('Enter');
  await expect(turn(page, 'stream fast two').first()).toBeVisible();
  await expect(turn(page, 'stream fast one').first()).toBeVisible();
  const texts = await page.locator('article.turn .msg.user .msg-text').allTextContents();
  const one = texts.findIndex((x) => x.includes('stream fast one'));
  const two = texts.findIndex((x) => x.includes('stream fast two'));
  expect(one).toBeGreaterThanOrEqual(0);
  expect(two).toBeGreaterThan(one);
  await expect(page.locator('article.turn.queued')).toHaveCount(0);
});

test('a weak-match project is deleted before filing: "Ready to file", then File', async ({ page }) => {
  const project = await seedProject(page, 'Streamweak');
  const t = await send(page, 'stream plan Streamweak sync');
  await expect(reply(t)).toContainText('Which project');
  const id = await captureId(t);
  expect((await api(page, 'DELETE', `/api/projects/${project.id}`)).status).toBe(204);

  await page.reload();
  const again = page.locator(`article.turn[data-capture="${id}"]`);
  await expect(reply(again)).toContainText('Ready to file');
  await expect(reply(again)).not.toContainText(/working/i);
  await expect(again.locator('.chip')).toHaveText(['File', 'Discard']);
  await composer(page).focus();
  await page.keyboard.press('ArrowUp');
  await expect(again).toHaveClass(/selected/);
  await page.keyboard.press('ArrowRight');
  await expect(again.locator('.chip.highlighted')).toHaveText('File');
  await page.keyboard.press('Enter');
  await expect(reply(again)).toContainText('Saved as a note');
  await expect(reply(again)).not.toContainText('Streamweak');
});

test('a 401 while sending keeps the text queued and sends it after re-login', async ({ sparePage, diag }) => {
  diag.allow(EXPECTED_401);
  const page = await sparePage(4);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  // Spend the app's first session re-check now (its throttle starts at zero, so the first focus event always goes
  // out). Everything below then happens inside the 5 s throttle window and nothing can lock the app early.
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/auth/session') && r.request().method() === 'GET');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await checked;
  // Type first, then end the session on the server and press Enter at once, so the app has no time to notice on its own
  // (a focus re-check would lock it before the send and the test would not exercise the queue).
  await composer(page).focus();
  await composer(page).fill('/note stream sent after lock');
  await page.evaluate(async () => {
    const s = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-xo-csrf': s.csrfToken } });
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(composer(page)).toHaveCount(0);

  await loginWithKeyboard(page);
  const t = turn(page, 'stream sent after lock').first();
  await expect(t).toBeVisible();
  await expect(reply(t)).toContainText('Saved as a note');
  await expect(page.locator('article.turn.queued')).toHaveCount(0);
});

test.describe('phone width', () => {
  test('the composer stays at the bottom, the log scrolls, the mic button is large', async ({ page }) => {
    for (let i = 1; i <= 14; i++) {
      expect((await api(page, 'POST', '/api/captures', { text: `/note stream bulk ${i}`, source: 'text' })).status).toBe(201);
    }
    await page.setViewportSize({ width: 390, height: 700 });
    await page.reload();
    await expect(turn(page, 'stream bulk 14').first()).toBeVisible();
    const box = await composer(page).boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(700);
    expect(box!.y + box!.height).toBeGreaterThan(560);
    const log = page.locator(sel.stream);
    const m = await log.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight, top: el.scrollTop }));
    expect(m.scroll).toBeGreaterThan(m.client); // it overflows and scrolls, the page itself does not
    expect(m.top).toBeGreaterThan(0);          // opened at the newest message
    const mic = await page.locator(sel.mic).boundingBox();
    expect(mic!.height).toBeGreaterThanOrEqual(44);
    expect(mic!.x + mic!.width).toBeLessThanOrEqual(390);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
});
