import type { Page } from '@playwright/test';
import type { Action } from '../src/shared/types.ts';
import { api, expect, mouseCount, noHorizontalOverflow, seedAction, seedNote, seedPerson, seedProject, sel, test } from './helpers.ts';

// Browser check for step C4: the Actions, Notes and Note documents. Seed names carry the prefix "work<n>" so
// this spec shares the DB and the stream with the other specs without clashing with them.

const panel = (page: Page) => page.locator(sel.panel);
const group = (page: Page, title: string) => panel(page).locator('.work-group').filter({ has: page.locator('.work-group-title', { hasText: title }) });
const listbox = (page: Page, title: string) => panel(page).getByRole('listbox', { name: `Actions: ${title}` });
const row = (page: Page, text: string) => panel(page).getByRole('option').filter({ hasText: text });

/** Loads the app (so the seeds can call the API), runs `seed`, then reloads so the stores see the seeded data. */
async function openWith(page: Page, hash: string, seed: () => Promise<void>): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator(sel.composer)).toBeVisible();
  await seed();
  await page.reload();
  await expect(page.locator(sel.composer)).toBeVisible();
  await page.goto(`/#${hash}`);
}

async function groupTitles(page: Page, prefix: string): Promise<string[]> {
  const all = await panel(page).locator('.work-group-title').allTextContents();
  return all.map((t) => t.trim()).filter((t) => t.startsWith(prefix) || t.startsWith('No project'));
}

test('groups by project in order, filters by person, shows done on request', async ({ page }) => {
  await openWith(page, '/actions', async () => {
    const anna = await seedPerson(page, 'work1 Anna');
    const bert = await seedPerson(page, 'work1 Bert');
    const zulu = await seedProject(page, 'work1 Zulu');
    const alpha = await seedProject(page, 'work1 Alpha');
    const hold = await seedProject(page, 'work1 Hold', { status: 'on_hold' });
    await seedAction(page, 'work1 zulu task', { projectId: zulu.id, personId: anna.id });
    await seedAction(page, 'work1 alpha task', { projectId: alpha.id, personId: bert.id });
    await seedAction(page, 'work1 hold task', { projectId: hold.id });
    await seedAction(page, 'work1 loose task', { owner: 'them', personId: anna.id });
    const done = await seedAction(page, 'work1 finished task', { projectId: alpha.id });
    await api(page, 'PATCH', `/api/actions/${done.id}`, { status: 'done' });
  });

  await expect(panel(page).getByRole('heading', { name: 'Actions' })).toBeVisible();
  await expect(row(page, 'work1 zulu task')).toBeVisible();
  const titles = await groupTitles(page, 'work1');
  expect(titles.map((t) => t.replace(/ \(.*\)$/, ''))).toEqual(['work1 Alpha', 'work1 Zulu', 'work1 Hold', 'No project']);
  await expect(row(page, 'work1 loose task')).toContainText('Waiting on work1 Anna');
  await expect(row(page, 'work1 finished task')).toHaveCount(0);

  // Person filter via the picker; it lists only that person's actions.
  await panel(page).getByRole('button', { name: 'Person: any' }).click();
  await page.keyboard.type('work1 Anna');
  await page.keyboard.press('ArrowDown'); // None is the first row; Anna the second
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Person: work1 Anna' })).toBeVisible();
  await expect(row(page, 'work1 zulu task')).toBeVisible();
  await expect(row(page, 'work1 loose task')).toBeVisible();
  await expect(row(page, 'work1 alpha task')).toHaveCount(0);

  // The filter outlives the document.
  await page.keyboard.press('Escape');
  await page.goto('/#/actions');
  await expect(panel(page).getByRole('button', { name: 'Person: work1 Anna' })).toBeVisible();

  // Clear it again (None).
  await panel(page).getByRole('button', { name: 'Person: work1 Anna' }).click();
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Person: any' })).toBeVisible();
  await expect(row(page, 'work1 alpha task')).toBeVisible();

  // Show done.
  await panel(page).getByLabel('Show done').check();
  await expect(row(page, 'work1 finished task')).toBeVisible();
  await expect(row(page, 'work1 finished task')).toContainText('(done)');
  await panel(page).getByLabel('Show done').uncheck();
  await expect(row(page, 'work1 finished task')).toHaveCount(0);
});

test('keyboard only: done with Enter, move to another project, delete asks first', async ({ page }) => {
  await openWith(page, '/actions', async () => {
    const alpha = await seedProject(page, 'work2 Alpha');
    const beta = await seedProject(page, 'work2 Beta');
    await seedAction(page, 'work2 toggle me', { projectId: alpha.id });
    await seedAction(page, 'work2 move me', { projectId: alpha.id });
    await seedAction(page, 'work2 delete me', { projectId: beta.id });
  });
  await expect(row(page, 'work2 toggle me')).toBeVisible();
  expect(await groupTitles(page, 'work2')).toContain('work2 Alpha');
  expect(await groupTitles(page, 'work2')).toContain('work2 Beta');

  // Enter on the highlighted row runs its first chip: Done.
  await listbox(page, 'work2 Alpha').focus();
  await expect(row(page, 'work2 toggle me')).toHaveAttribute('aria-selected', 'true'); // oldest first
  await page.keyboard.press('Enter');
  await expect(row(page, 'work2 toggle me')).toHaveCount(0);
  const done = await api<{ actions: Action[] }>(page, 'GET', '/api/actions?status=done&limit=200');
  expect(done.json.actions.some((a) => a.text === 'work2 toggle me')).toBe(true);

  // Move: Right x3 reaches "Project…" (Done, Edit, Project…), Enter opens the picker.
  await expect(row(page, 'work2 move me')).toHaveAttribute('aria-selected', 'true'); // the highlight moved on
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Pick project' })).toBeVisible();
  await page.keyboard.type('work2 Beta');
  await page.keyboard.press('ArrowDown'); // None first
  await page.keyboard.press('Enter');
  await expect(group(page, 'work2 Beta').getByRole('option').filter({ hasText: 'work2 move me' })).toBeVisible();
  await expect(group(page, 'work2 Alpha')).toHaveCount(0); // no actions left there
  expect(await groupTitles(page, 'work2').then((t) => t.filter((x) => x.startsWith('work2')))).toEqual(['work2 Beta']);

  // Delete: Left from "no chip" picks the last chip (Delete); Enter asks, No keeps it, Yes deletes.
  await listbox(page, 'work2 Beta').focus();
  await page.keyboard.press('ArrowDown'); // move me (older) first, delete me second
  await expect(row(page, 'work2 delete me')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog', { name: 'Confirm' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('work2 delete me');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(row(page, 'work2 delete me')).toBeVisible();
  await listbox(page, 'work2 Beta').focus();
  await page.keyboard.press('Enter');
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Tab'); // No -> Yes
  await page.keyboard.press('Enter');
  await expect(row(page, 'work2 delete me')).toHaveCount(0);
  const open = await api<{ actions: Action[] }>(page, 'GET', '/api/actions?status=all&limit=200');
  expect(open.json.actions.some((a) => a.text === 'work2 delete me')).toBe(false);
  expect(open.json.actions.some((a) => a.text === 'work2 move me')).toBe(true);
  expect(await mouseCount(page)).toBe(0);
});

test('add field: a failed request keeps the text, a retry adds it; edit changes the text', async ({ page, diag }) => {
  diag.allow(/net::ERR_FAILED|Failed to load resource/);
  await openWith(page, '/actions', async () => {
    const alpha = await seedProject(page, 'work3 Alpha');
    await seedAction(page, 'work3 old text', { projectId: alpha.id });
  });
  await expect(row(page, 'work3 old text')).toBeVisible();

  const add = panel(page).getByLabel('Add an action to work3 Alpha');
  let blockPosts = true;
  await page.route('**/api/actions', async (route) => {
    if (blockPosts && route.request().method() === 'POST') await route.abort();
    else await route.continue();
  });
  await add.fill('work3 new item');
  await add.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /reach the server/i }).first()).toBeVisible();
  await expect(add).toHaveValue('work3 new item');
  await expect(row(page, 'work3 new item')).toHaveCount(0);

  blockPosts = false;
  await add.press('Enter');
  await expect(row(page, 'work3 new item')).toBeVisible();
  await expect(add).toHaveValue('');
  await page.unroute('**/api/actions');

  // Edit through the dialog (second chip).
  await listbox(page, 'work3 Alpha').focus();
  await expect(row(page, 'work3 old text')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit action' });
  await expect(dialog.getByRole('textbox')).toHaveValue('work3 old text');
  await page.keyboard.type('work3 edited text'); // the text is pre-selected
  await page.keyboard.press('Enter');
  await expect(row(page, 'work3 edited text')).toBeVisible();
  await expect(row(page, 'work3 old text')).toHaveCount(0);
});

test('notes: list with labels, add, open, edit body (autosave, survives reload), project, delete', async ({ page }) => {
  await openWith(page, '/notes', async () => {
    const anna = await seedPerson(page, 'work5 Anna');
    const alpha = await seedProject(page, 'work5 Alpha');
    await seedProject(page, 'work5 Beta');
    await seedNote(page, 'work5 seeded body line\nsecond line', { personId: anna.id, projectId: alpha.id });
  });
  const seeded = row(page, 'work5 seeded body line');
  await expect(seeded).toBeVisible();
  await expect(seeded).toContainText('work5 Anna');
  await expect(seeded).toContainText('work5 Alpha');

  // Add a note with the add field; notes are listed newest first.
  const add = panel(page).getByLabel('Add a note');
  await add.fill('work5 quick note');
  await add.press('Enter');
  await expect(row(page, 'work5 quick note')).toBeVisible();
  await expect(add).toHaveValue('');

  // Open it with the keyboard: the list highlights the first row, Enter opens.
  await panel(page).getByRole('listbox', { name: 'Notes' }).focus();
  await expect(row(page, 'work5 quick note')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  const body = panel(page).getByRole('textbox', { name: 'Note body' });
  await expect(body).toHaveValue('work5 quick note');
  await expect(page).toHaveURL(/#\/notes\/\d+$/);

  // Edit: autosave after a pause, then reload and see the saved text.
  const saved = page.waitForResponse((r) => /\/api\/notes\/\d+$/.test(r.url()) && r.request().method() === 'PATCH');
  await body.fill('work5 body edited\nwith two lines');
  await saved;
  await page.reload();
  await expect(panel(page).getByRole('textbox', { name: 'Note body' })).toHaveValue('work5 body edited\nwith two lines');

  // Project.
  await panel(page).getByRole('button', { name: 'Change project' }).click();
  await page.keyboard.type('work5 Beta');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(panel(page).getByText('work5 Beta')).toBeVisible();
  const list = await api<{ notes: { preview: string; projectId: number | null }[] }>(page, 'GET', '/api/notes?limit=50');
  expect(list.json.notes.find((n) => n.preview.startsWith('work5 body edited'))?.projectId).not.toBeNull();

  // Delete asks, then returns to the list with replace (Back does not reopen the note).
  await panel(page).getByRole('button', { name: 'Delete note' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Yes' }).click();
  await expect(page).toHaveURL(/#\/notes$/);
  await expect(panel(page).getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(row(page, 'work5 body edited')).toHaveCount(0);
  await expect(seeded).toBeVisible();
});

test('phone width: Actions opens as one panel and Back returns to the chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator(sel.composer)).toBeVisible();
  const alpha = await seedProject(page, 'work6 Alpha');
  await seedAction(page, 'work6 a fairly long action text that has to wrap inside a narrow panel without overflow', { projectId: alpha.id });
  await page.reload();
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await page.locator(sel.sidebar).getByRole('link', { name: 'Actions' }).click();
  await expect(row(page, 'work6 a fairly long')).toBeVisible();
  await expect(page.locator(sel.composer)).toHaveCount(0);
  expect(await noHorizontalOverflow(page)).toBe(true);
  await panel(page).getByRole('button', { name: 'Back' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(sel.composer)).toBeVisible();
});

test('note: a blank title is not saved; the stored title comes back', async ({ page }) => {
  let id = 0;
  await openWith(page, '/notes', async () => { id = (await seedNote(page, 'work7 body', { title: 'work7 Title' })).id; });
  await page.goto(`/#/notes/${id}`);
  const title = panel(page).getByRole('textbox', { name: 'Note title' });
  await expect(title).toHaveValue('work7 Title');
  await title.fill('');
  await title.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'A note needs a title' }).first()).toBeVisible();
  await expect(panel(page).getByRole('textbox', { name: 'Note title' })).toHaveValue('work7 Title');
  const got = await api<{ title: string }>(page, 'GET', `/api/notes/${id}`);
  expect(got.json.title).toBe('work7 Title');
});
