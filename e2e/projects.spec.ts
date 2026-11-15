import type { Page } from '@playwright/test';
import type { Action, Note } from '../src/shared/types.ts';
import type { ProjectDetailResponse, ProjectsListResponse } from '../src/shared/api.ts';
import { api, expect, mouseCount, noHorizontalOverflow, seedAction, seedNote, seedPerson, seedProject, sel, test } from './helpers.ts';

// Browser check for step C6: the Projects list and the Project document. Names are prefixed "proj" and made
// unique per run; every assertion is about items this spec created.

const panel = (page: Page) => page.locator(sel.panel);
const composer = (page: Page) => page.locator(sel.composer);
const palette = (page: Page) => page.locator(sel.palette);
const uniq = () => `${Date.now() % 1000000}${Math.floor(Math.random() * 100)}`;

async function projectId(page: Page, title: string): Promise<number> {
  const r = await api<ProjectsListResponse>(page, 'GET', '/api/projects');
  const p = r.json.projects.find((x) => x.title === title);
  if (!p) throw new Error(`no project ${title}`);
  return p.id;
}
const detailOf = async (page: Page, id: number) => (await api<ProjectDetailResponse>(page, 'GET', `/api/projects/${id}`)).json;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
});

test('create from the list and from the palette; rename; on hold moves the group', async ({ page }) => {
  const a = `proj Apollo ${uniq()}`;
  const b = `proj Borealis ${uniq()}`;
  const renamed = `${a} v2`;

  await page.goto('/#/projects');
  await expect(panel(page).getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();
  const add = panel(page).getByRole('textbox', { name: 'New project…' });
  await add.fill(a);
  await add.press('Enter');
  await expect(page).toHaveURL(/#\/projects\/\d+$/);
  await expect(panel(page).getByRole('heading', { name: a, level: 2 })).toBeVisible();
  await expect(panel(page).getByRole('textbox', { name: 'Project title' })).toHaveValue(a);

  // Palette: New project.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Meta+k');
  await page.keyboard.type('new project');
  await page.keyboard.press('Enter');
  const prompt = page.getByRole('dialog', { name: 'New project' });
  await expect(prompt.getByRole('textbox')).toBeFocused();
  await page.keyboard.type(b);
  await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('heading', { name: b, level: 2 })).toBeVisible();
  await expect(palette(page)).toHaveCount(0);

  // Back to A, rename it.
  const idA = await projectId(page, a);
  await page.goto(`/#/projects/${idA}`);
  const title = panel(page).getByRole('textbox', { name: 'Project title' });
  await expect(title).toHaveValue(a);
  await title.fill(renamed);
  await title.press('Enter');
  await expect(panel(page).getByRole('heading', { name: renamed, level: 2 })).toBeVisible();
  expect((await detailOf(page, idA)).project.title).toBe(renamed);

  // Aliases are saved as a parsed list.
  const aliases = panel(page).getByRole('textbox', { name: /^Aliases/ });
  await aliases.fill('Apo, apo,  Åre ');
  await aliases.press('Enter');
  await expect.poll(async () => (await detailOf(page, idA)).project.aliases).toEqual(['Apo', 'Åre']);

  // On hold: it leaves Active and shows under On hold.
  await panel(page).getByRole('combobox', { name: 'Status' }).selectOption('on_hold');
  await expect.poll(async () => (await detailOf(page, idA)).project.status).toBe('on_hold');
  await page.goto('/#/projects');
  const hold = panel(page).getByRole('region', { name: 'On hold' });
  await expect(hold.getByRole('option', { name: new RegExp(renamed) })).toBeVisible();
  await expect(panel(page).getByRole('region', { name: 'Active' }).getByRole('option', { name: new RegExp(renamed) })).toHaveCount(0);
  await expect(panel(page).getByRole('region', { name: 'Active' }).getByRole('option', { name: new RegExp(b) })).toBeVisible();
});

test('two actions and a note are added from the document; actions can be completed and reopened', async ({ page }) => {
  const t = `proj Cedar ${uniq()}`;
  const p = await seedProject(page, t);
  await page.goto(`/#/projects/${p.id}`);
  await expect(panel(page).getByRole('heading', { name: t, level: 2 })).toBeVisible();

  const addAction = panel(page).getByRole('textbox', { name: 'Add an action…' });
  await addAction.fill('proj write the brief');
  await addAction.press('Enter');
  const open = panel(page).getByRole('listbox', { name: 'Open actions' });
  await expect(open.getByRole('option', { name: /proj write the brief/ })).toBeVisible();
  await expect(addAction).toHaveValue('');
  await addAction.fill('proj book the venue');
  await addAction.press('Enter');
  await expect(open.getByRole('option')).toHaveCount(2);

  const addNote = panel(page).getByRole('textbox', { name: 'Add a note…' });
  await addNote.fill('proj kickoff went well');
  await addNote.press('Enter');
  await expect(panel(page).getByRole('listbox', { name: 'Project notes' }).getByRole('option', { name: /kickoff went well/ })).toBeVisible();
  const d = await detailOf(page, p.id);
  expect(d.openActions.map((a) => a.text).sort()).toEqual(['proj book the venue', 'proj write the brief']);
  expect(d.notes).toHaveLength(1);

  // Edit an action's text through the shared dialog.
  await open.getByRole('option', { name: /book the venue/ }).getByRole('button', { name: 'Edit' }).click();
  const dlg = page.getByRole('dialog', { name: 'Edit action' });
  await expect(dlg.getByRole('textbox')).toBeFocused();
  await page.keyboard.press('End'); // the dialog selects the whole text
  await page.keyboard.type(' now');
  await page.keyboard.press('Enter');
  await expect(open.getByRole('option', { name: /book the venue now/ })).toBeVisible();

  // Complete one action with the Done chip: it moves to the collapsed done list.
  await open.getByRole('option', { name: /write the brief/ }).getByRole('button', { name: 'Done' }).click();
  await expect(open.getByRole('option')).toHaveCount(1);
  await panel(page).getByRole('button', { name: /Show done actions \(1\)/ }).click();
  const done = panel(page).getByRole('listbox', { name: 'Done actions' });
  await expect(done.getByRole('option', { name: /write the brief/ })).toBeVisible();
  await done.getByRole('option').getByRole('button', { name: 'Reopen' }).click();
  await expect(open.getByRole('option')).toHaveCount(2);
  // The list in the Projects document carries the open count.
  await page.goto('/#/projects');
  await expect(panel(page).getByRole('option', { name: new RegExp(`${t}.*2 open`) })).toBeVisible();
});

test('a person is linked and unlinked', async ({ page }) => {
  const person = await seedPerson(page, `proj Lena ${uniq()}`);
  const p = await seedProject(page, `proj Delta ${uniq()}`);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await page.goto(`/#/projects/${p.id}`);
  await expect(panel(page).getByRole('heading', { name: p.title, level: 2 })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Add person' }).click();
  const picker = page.getByRole('dialog', { name: 'Pick person' });
  await expect(picker.getByRole('combobox')).toBeFocused();
  await page.keyboard.type(person.name.toLowerCase());
  await page.keyboard.press('Enter');
  const people = panel(page).getByRole('listbox', { name: 'People on this project' });
  await expect(people.getByRole('option', { name: new RegExp(person.name) })).toBeVisible();
  expect((await detailOf(page, p.id)).people.map((x) => x.id)).toEqual([person.id]);

  await people.getByRole('option').getByRole('button', { name: 'Remove' }).click();
  await expect(people.getByRole('option')).toHaveCount(0);
  expect((await detailOf(page, p.id)).people).toEqual([]);
});

test('the description autosaves and survives a reload', async ({ page }) => {
  const p = await seedProject(page, `proj Echo ${uniq()}`);
  await page.goto(`/#/projects/${p.id}`);
  const desc = panel(page).getByRole('textbox', { name: 'Description' });
  await expect(desc).toHaveValue('');
  await desc.fill('proj Goal: ship Åre by Friday');
  await expect.poll(async () => (await detailOf(page, p.id)).project.descriptionMd, { timeout: 5000 }).toBe('proj Goal: ship Åre by Friday');
  await page.reload();
  await expect(panel(page).getByRole('textbox', { name: 'Description' })).toHaveValue('proj Goal: ship Åre by Friday');
});

test('deleting a project removes it everywhere but keeps its action and note', async ({ page, diag }) => {
  diag.allow(/status of 404/); // the deliberate look at the deleted project
  const p = await seedProject(page, `proj Fjord ${uniq()}`);
  const action = await seedAction(page, 'proj fjord action', { projectId: p.id });
  const note = await seedNote(page, 'proj fjord note body', { projectId: p.id });
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await page.goto(`/#/projects/${p.id}`);
  await expect(panel(page).getByRole('heading', { name: p.title, level: 2 })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Delete project' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm' });
  await expect(confirm).toContainText('actions and notes are kept');
  await expect(confirm).toContainText('lose the project');
  await confirm.getByRole('button', { name: 'Yes' }).click();

  await expect(page).toHaveURL(/#\/projects$/);
  await expect(panel(page).getByRole('heading', { name: 'Projects', level: 2 })).toBeVisible();
  await expect(panel(page).getByRole('option', { name: new RegExp(p.title) })).toHaveCount(0);
  await expect(page.locator(sel.sidebar).getByText(p.title)).toHaveCount(0);
  await page.keyboard.press('Meta+k');
  await page.keyboard.type(p.title);
  await expect(palette(page).getByRole('option', { name: new RegExp(p.title) })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The detail is gone (404), the action and note stay, without a project.
  expect((await api(page, 'GET', `/api/projects/${p.id}`)).status).toBe(404);
  const actions = (await api<{ actions: Action[] }>(page, 'GET', '/api/actions?projectId=none&status=all')).json.actions;
  expect(actions.find((a) => a.id === action.id)?.projectId).toBeNull();
  const n = (await api<Note>(page, 'GET', `/api/notes/${note.id}`)).json;
  expect(n.projectId).toBeNull();
  // Opening the deleted project's address shows a message, not an error.
  await page.goto(`/#/projects/${p.id}`);
  await expect(panel(page).getByText('no longer exists')).toBeVisible();
});

test('keyboard only: add an action and complete it from the list', async ({ page }) => {
  const p = await seedProject(page, `proj Gamma ${uniq()}`);
  await page.goto('/#/projects');
  const row = panel(page).getByRole('option', { name: new RegExp(p.title) });
  await expect(row).toBeVisible();
  const before = await mouseCount(page);

  // Focus the Active list, move to the row (Down), open it (Enter).
  await panel(page).getByRole('listbox', { name: 'Active projects' }).focus();
  for (let i = 0; i < 50; i++) {
    if ((await row.getAttribute('aria-selected')) === 'true') break;
    await page.keyboard.press('ArrowDown');
  }
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/projects/${p.id}$`));
  await expect(panel(page).getByRole('textbox', { name: 'Project title' })).toHaveValue(p.title);

  // Into the add-action field by keyboard, then the list: Up from the empty field returns to it.
  const add = panel(page).getByRole('textbox', { name: 'Add an action…' });
  await add.focus();
  await page.keyboard.type('proj keyboard action');
  await page.keyboard.press('Enter');
  const open = panel(page).getByRole('listbox', { name: 'Open actions' });
  await expect(open.getByRole('option', { name: /keyboard action/ })).toBeVisible();
  await page.keyboard.press('ArrowUp'); // empty add field -> back to the list, last row highlighted
  await expect(open).toBeFocused();
  await expect(open.getByRole('option', { name: /keyboard action/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter'); // first chip: Done
  await expect(open.getByRole('option')).toHaveCount(0);
  expect((await detailOf(page, p.id)).doneActions.map((a) => a.text)).toEqual(['proj keyboard action']);
  expect(await mouseCount(page)).toBe(before);
});

test('at 390 px the document fits the screen and works', async ({ page }) => {
  const p = await seedProject(page, `proj Phone ${uniq()}`);
  await seedAction(page, 'proj phone action', { projectId: p.id });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/#/projects');
  const row = panel(page).getByRole('option', { name: new RegExp(p.title) });
  await expect(row).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  await row.click();
  await expect(panel(page).getByRole('textbox', { name: 'Project title' })).toHaveValue(p.title);
  await expect(panel(page).getByRole('option', { name: /phone action/ })).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const box = await panel(page).getByRole('button', { name: 'Delete project' }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
});

test('a failed create keeps the typed text in the add field', async ({ page, diag }) => {
  diag.allow(/ERR_FAILED|Failed to load resource/);
  const t = `proj Fail ${uniq()}`;
  await page.goto('/#/projects');
  const add = panel(page).getByRole('textbox', { name: 'New project…' });
  await expect(add).toBeVisible();
  await page.route('**/api/projects', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue()));
  await add.fill(t);
  await add.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /./ }).first()).toBeVisible();
  await expect(add).toHaveValue(t);
  await expect(page).toHaveURL(/#\/projects$/);
  await page.unroute('**/api/projects');
  await add.press('Enter');
  await expect(panel(page).getByRole('heading', { name: t, level: 2 })).toBeVisible();
});
