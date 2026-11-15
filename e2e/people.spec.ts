import type { Page } from '@playwright/test';
import type { MeetingDetail } from '../src/shared/types.ts';
import { api, expect, EXPECTED_401, loginWithKeyboard, mouseCount, noHorizontalOverflow, seedAction, seedPerson, seedProject, sel, test } from './helpers.ts';

// Browser check for step C5: People, Person and the 1-1 meeting document. All names start with "people" so
// this spec can share the DB and the stream with the other specs.

const panel = (page: Page) => page.locator(sel.panel);
const heading = (page: Page, name: string) => panel(page).getByRole('heading', { name, level: 2 });

async function meetingIdFromUrl(page: Page): Promise<number> {
  await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  return Number(/#\/meetings\/(\d+)$/.exec(page.url())![1]);
}

test.describe('the 1-1 loop (keyboard only)', () => {
  test('agenda, start, check off, follow-ups for me and them, notes, end, next 1-1 carries over', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator(sel.composer)).toBeVisible();

    const anna = await seedPerson(page, 'people Anna');
    const apollo = await seedProject(page, 'people Apollo');
    const zephyr = await seedProject(page, 'people Zephyr');
    await seedAction(page, 'people apollo task', { owner: 'me', personId: anna.id, projectId: apollo.id });
    await seedAction(page, 'people zephyr wait', { owner: 'them', personId: anna.id, projectId: zephyr.id });
    await seedAction(page, 'people loose task', { owner: 'me', personId: anna.id });

    // A fresh load so the projects store knows the new projects.
    await page.goto(`/#/people/${anna.id}`);
    await page.reload();
    await expect(heading(page, 'people Anna')).toBeVisible();
    await expect(panel(page).getByRole('listbox', { name: 'Agenda' })).toBeAttached(); // empty: zero height

    // The person's open actions show their project labels.
    const open = panel(page).getByRole('listbox', { name: 'Open actions' });
    await expect(open.getByRole('option', { name: /people apollo task.*people Apollo/ })).toBeVisible();
    await expect(open.getByRole('option', { name: /people loose task/ })).toBeVisible();

    // Agenda: Down in an empty list lands in the add field; Enter adds and keeps the field.
    const agenda = panel(page).getByRole('listbox', { name: 'Agenda' });
    await agenda.focus();
    await page.keyboard.press('ArrowDown');
    const addAgenda = panel(page).getByPlaceholder('Add an agenda item…');
    await expect(addAgenda).toBeFocused();
    await page.keyboard.type('people topic one');
    await page.keyboard.press('Enter');
    await expect(agenda.getByRole('option', { name: /people topic one/ })).toBeVisible();
    await page.keyboard.type('people topic two');
    await page.keyboard.press('Enter');
    await expect(agenda.getByRole('option', { name: /people topic two/ })).toBeVisible();
    await expect(addAgenda).toHaveValue('');

    // Start the 1-1 with Enter on the button.
    await panel(page).getByRole('button', { name: 'Start 1-1' }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page, '1-1 · people Anna')).toBeVisible();
    const meetingId = await meetingIdFromUrl(page);
    const meetingAgenda = panel(page).getByRole('listbox', { name: 'Agenda' });
    await expect(meetingAgenda.getByRole('option')).toHaveCount(2);

    // Check the first item off: Enter on the highlighted row runs its first chip.
    await meetingAgenda.focus();
    await page.keyboard.press('Enter');
    await expect(meetingAgenda.getByRole('option', { name: /Checked: people topic one/ })).toBeVisible();
    await expect(meetingAgenda.getByRole('option', { name: /Open: people topic two/ })).toBeVisible();
    await expect.poll(async () => (await api<MeetingDetail>(page, 'GET', `/api/meetings/${meetingId}`)).json.resolvedHere.map((i) => i.text))
      .toEqual(['people topic one']);

    // Follow-up for me, then for them (the owner toggle is a real button).
    const followMe = panel(page).getByPlaceholder('Add a follow-up for me…');
    await followMe.focus();
    await page.keyboard.type('people send deck');
    await page.keyboard.press('Enter');
    const followUps = panel(page).getByRole('listbox', { name: 'Follow-ups' });
    await expect(followUps.getByRole('option', { name: /people send deck/ })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Them', exact: true }).focus();
    await page.keyboard.press('Space');
    const followThem = panel(page).getByPlaceholder('Add a follow-up for people Anna…');
    await expect(followThem).toBeVisible();
    await followThem.focus();
    await page.keyboard.type('people review budget');
    await page.keyboard.press('Enter');
    await expect(followUps.getByRole('option', { name: /Them.*people review budget/ })).toBeVisible();
    await expect.poll(async () => (await api<MeetingDetail>(page, 'GET', `/api/meetings/${meetingId}`)).json.actionsHere.map((a) => `${a.owner}:${a.text}`))
      .toEqual(['me:people send deck', 'them:people review budget']);

    // The person's other open actions, grouped by project name (active projects by title, then No project).
    const others = panel(page).getByRole('region', { name: 'Open actions' });
    await expect(others.getByRole('heading', { level: 4 })).toHaveText(['people Apollo', 'people Zephyr', 'No project']);
    await expect(others.getByRole('listbox', { name: 'Open actions: people Apollo' }).getByRole('option', { name: /people apollo task/ })).toBeVisible();
    await expect(others.getByRole('listbox', { name: 'Open actions: people Zephyr' }).getByRole('option', { name: /Them.*people zephyr wait/ })).toBeVisible();
    // Finish one of them from here.
    const loose = others.getByRole('listbox', { name: 'Open actions: No project' });
    await loose.focus();
    await page.keyboard.press('Enter');
    await expect(loose.getByRole('option', { name: /people loose task/ }).getByRole('button', { name: 'Reopen' })).toBeVisible();

    // Notes: type, then Esc saves and leaves the field; the panel stays open.
    const notes = panel(page).getByLabel('Meeting notes');
    await notes.focus();
    await page.keyboard.type('people notes of the first 1-1');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeVisible();
    await expect.poll(async () => (await api<MeetingDetail>(page, 'GET', `/api/meetings/${meetingId}`)).json.meeting.notesMd)
      .toBe('people notes of the first 1-1');

    // End the meeting: the confirm starts on "No"; Tab to "Yes" and Enter.
    await panel(page).getByRole('button', { name: 'End meeting' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Confirm' })).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('This 1-1 has ended and is read-only.')).toBeVisible();
    await expect(panel(page).getByPlaceholder('Add an agenda item…')).toHaveCount(0);
    await expect(panel(page).getByLabel('Meeting notes')).toHaveCount(0); // read-only text, not an editor
    await expect(panel(page).getByText('people notes of the first 1-1').first()).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'Open actions' })).toHaveCount(0);

    // Back to the person (button + Enter), start the next 1-1.
    await panel(page).getByRole('button', { name: 'people Anna', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page, 'people Anna')).toBeVisible();
    await expect(panel(page).getByRole('listbox', { name: 'Meetings' }).getByRole('option', { name: /ended/ })).toHaveCount(1);
    await panel(page).getByRole('button', { name: 'Start 1-1' }).focus();
    await page.keyboard.press('Enter');
    await expect(heading(page, '1-1 · people Anna')).toBeVisible();
    await expect.poll(async () => (await meetingIdFromUrl(page)) !== meetingId).toBe(true);

    // Carried over: the unchecked item is here, the checked one is not; the previous notes and follow-ups show.
    const nextAgenda = panel(page).getByRole('listbox', { name: 'Agenda' });
    await expect(nextAgenda.getByRole('option', { name: /people topic two/ })).toBeVisible();
    await expect(nextAgenda.getByRole('option', { name: /people topic one/ })).toHaveCount(0);
    const previous = panel(page).getByRole('region', { name: 'Previous 1-1' });
    await expect(previous.getByText('people notes of the first 1-1')).toBeVisible();
    await expect(previous.getByText(/\(Me\) people send deck/)).toBeVisible();
    await expect(previous.getByText(/\(Them\) people review budget/)).toBeVisible();
    await expect(previous.getByText(/☑ people topic one/)).toBeVisible();
    // The follow-ups of the earlier meeting are among the person's open actions now; the finished one is not.
    const nextOthers = panel(page).getByRole('region', { name: 'Open actions' });
    await expect(nextOthers.getByRole('option', { name: /people send deck/ })).toBeVisible();
    await expect(nextOthers.getByRole('option', { name: /people loose task/ })).toHaveCount(0);

    expect(await mouseCount(page)).toBe(0);
  });
});

test.describe('people list', () => {
  test('adds a person and opens or starts a 1-1 from the row chips', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/people');
    const list = panel(page).getByRole('listbox', { name: 'People' });
    await expect(list).toBeVisible();
    const add = panel(page).getByPlaceholder('Add a person…');
    await add.fill('people Bo');
    await add.press('Enter');
    const row = list.getByRole('option', { name: /people Bo/ });
    await expect(row).toBeVisible();
    await expect(add).toHaveValue('');
    await row.getByRole('button', { name: 'Open' }).click();
    await expect(heading(page, 'people Bo')).toBeVisible();
    await page.goBack();
    await expect(list).toBeVisible();
    await list.getByRole('option', { name: /people Bo/ }).getByRole('button', { name: 'Start 1-1' }).click();
    await expect(heading(page, '1-1 · people Bo')).toBeVisible();
  });
});

test.describe('session lock', () => {
  test('meeting notes typed before a 401 are saved after logging in again', async ({ sparePage, diag }) => {
    diag.allow(EXPECTED_401);
    const page = await sparePage(3);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator(sel.composer)).toBeVisible();
    const cy = await seedPerson(page, 'people Cy');
    const started = await api<MeetingDetail>(page, 'POST', `/api/people/${cy.id}/meetings`);
    expect(started.status).toBeLessThan(300);
    const meetingId = started.json.meeting.id;

    await page.goto(`/#/meetings/${meetingId}`);
    await expect(heading(page, '1-1 · people Cy')).toBeVisible();
    const notes = panel(page).getByLabel('Meeting notes');
    await expect(notes).toBeVisible();
    await notes.fill('people draft written while the session ended');

    // Kill the session on the server before the autosave runs, then let the app notice.
    await page.evaluate(async () => {
      const s = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-xo-csrf': s.csrfToken } });
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(panel(page)).toHaveCount(0); // no meeting data stays in the DOM

    await loginWithKeyboard(page);
    await expect(heading(page, '1-1 · people Cy')).toBeVisible();
    await expect(panel(page).getByLabel('Meeting notes')).toHaveValue('people draft written while the session ended');
    await expect.poll(async () => (await api<MeetingDetail>(page, 'GET', `/api/meetings/${meetingId}`)).json.meeting.notesMd)
      .toBe('people draft written while the session ended');
  });
});

test.describe('phone width (390 px)', () => {
  test('person and meeting fit the screen and Back returns to the list', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const di = await seedPerson(page, 'people Di');
    const started = await api<MeetingDetail>(page, 'POST', `/api/people/${di.id}/meetings`);
    expect(started.status).toBeLessThan(300);

    await page.goto(`/#/people/${di.id}`);
    await expect(heading(page, 'people Di')).toBeVisible();
    await expect(page.locator(sel.composer)).toHaveCount(0); // one panel at a time
    await expect(panel(page).getByRole('button', { name: 'Resume 1-1' })).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    const add = panel(page).getByPlaceholder('Add an agenda item…');
    await add.scrollIntoViewIfNeeded();
    await add.fill('people phone topic');
    await add.press('Enter');
    await expect(panel(page).getByRole('option', { name: /people phone topic/ })).toBeVisible();

    await panel(page).getByRole('button', { name: 'Resume 1-1' }).click();
    await expect(heading(page, '1-1 · people Di')).toBeVisible();
    await expect(panel(page).getByRole('option', { name: /people phone topic/ })).toBeVisible();
    const notes = panel(page).getByLabel('Meeting notes');
    await notes.scrollIntoViewIfNeeded();
    expect((await notes.boundingBox())!.width).toBeLessThanOrEqual(390);
    expect(await noHorizontalOverflow(page)).toBe(true);

    await panel(page).getByRole('button', { name: 'Back' }).click();
    await expect(heading(page, 'people Di')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Back' }).click();
    await expect(heading(page, 'People')).toBeVisible();
  });
});
