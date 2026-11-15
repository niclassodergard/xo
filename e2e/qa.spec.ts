import { api, expect, mouseCount, noHorizontalOverflow, seedAction, seedNote, seedPerson, sel, test } from './helpers.ts';
import type { Capture } from '../src/shared/types.ts';
import type { Locator, Page } from '@playwright/test';

// Browser check for step Q2: question answering in the stream (fake LLM: the answer is "Found N item(s): <titles>"
// and cites the first two excerpts; `!!fail` fails the answer). Every test uses its own unique word, so retrieval
// only finds what that test seeded, and looks only at the turn it created.

const composer = (page: Page) => page.locator(sel.composer);
const turnById = (page: Page, id: number) => page.locator(`article.turn[data-capture="${id}"]`);
const reply = (t: Locator) => t.locator('.msg.xo');

/** Types a text in the composer and sends it; returns the landed turn (found by its text) and its capture id. */
async function ask(page: Page, text: string): Promise<{ turn: Locator; id: number }> {
  await composer(page).focus();
  await composer(page).fill(text);
  await page.keyboard.press('Enter');
  const shown = text.replace(/^\/(ask|q)\s+/, '');
  const t = page.locator('article.turn[data-capture]', { hasText: shown }).last();
  await expect(t).toBeVisible();
  await expect(t).toHaveAttribute('data-capture', /^[1-9]\d*$/);
  const id = Number(await t.getAttribute('data-capture'));
  return { turn: turnById(page, id), id };
}

/** Counts the `ask` requests the page makes. */
function countAsks(page: Page): { count: () => number } {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/captures\/\d+\/ask$/.test(new URL(r.url()).pathname)) n++; });
  return { count: () => n };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  await expect(page.locator(sel.stream)).toBeVisible();
});

test('/ask is answered with source chips; the keyboard picks a source and Enter opens it', async ({ page }) => {
  const anna = await seedPerson(page, 'Qa Anna');
  await seedNote(page, 'qapromise to send the budget before Friday', { title: 'Qa promise note', personId: anna.id });
  await seedAction(page, 'qapromise review the slides', { personId: anna.id });

  const { turn, id } = await ask(page, '/ask what did I promise Qa Anna? qapromise');
  await expect(reply(turn)).toContainText('Found'); // the fake answer
  const sources = turn.locator('.answer-sources .chip');
  await expect(sources.first()).toBeVisible();
  await expect(turn.getByRole('button', { name: 'Qa promise note' })).toBeVisible();
  await expect(turn.getByRole('button', { name: 'Delete answer' })).toBeVisible();
  await expect(composer(page)).toBeFocused(); // the answer never takes the keyboard

  await page.keyboard.press('ArrowUp'); // empty composer: into the stream at the newest turn
  await expect(page.locator(sel.stream)).toBeFocused();
  await expect(turnById(page, id)).toHaveClass(/selected/);
  // An answer defaults to its first source; step right until the note's chip is highlighted.
  for (let i = 0; i < 6; i++) {
    if ((await turn.locator('.chip.highlighted').textContent()) === 'Qa promise note') break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(turn.locator('.chip.highlighted')).toHaveText('Qa promise note');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/notes\/\d+$/);
  await expect(page.locator(sel.panel)).toBeVisible();
  await expect(page.locator(sel.panel).locator('textarea')).toHaveValue(/qapromise to send the budget/);
  expect(await mouseCount(page)).toBe(0);
});

test('a text ending in ? is answered without a prefix', async ({ page }) => {
  await seedNote(page, 'qaplain the board meets monday', { title: 'Qa plain note' });
  const { turn } = await ask(page, 'qaplain?');
  await expect(reply(turn)).toContainText('Found 1 item(s): Qa plain note');
  await expect(turn.getByRole('button', { name: 'Qa plain note' })).toBeVisible();
});

test('no matching data: a plain "nothing matches" state, no sources', async ({ page }) => {
  const { turn } = await ask(page, '/ask qazzznomatchtoken?');
  await expect(reply(turn)).toContainText('Nothing in your data matches that.');
  await expect(reply(turn)).toHaveClass(/tone-nomatch/);
  await expect(turn.locator('.answer-sources')).toHaveCount(0);
  await expect(turn.locator('.chip')).toHaveText(['Delete answer']);
});

test('an unsure question offers "Answer it"', async ({ page }) => {
  await seedNote(page, 'qaunsure the offsite is in june', { title: 'Qa unsure note' });
  const { turn } = await ask(page, 'qaunsure offsite??');
  await expect(reply(turn)).toContainText('What is this?');
  await expect(turn.getByRole('button', { name: 'Answer it' })).toBeVisible();
  await turn.getByRole('button', { name: 'Answer it' }).click();
  await expect(reply(turn)).toContainText('Found 1 item(s): Qa unsure note');
});

test('a failed answer keeps the question: Retry asks again, File instead turns it into a note', async ({ page, diag }) => {
  diag.allow(/Failed to load resource: the server responded with a status of 502/); // the deliberate failure
  await seedNote(page, 'qafail some context for the failing question', { title: 'Qa fail note' });
  const asks = countAsks(page);
  const { turn, id } = await ask(page, '/ask qafail !!fail');
  await expect(reply(turn)).toHaveClass(/tone-failed/);
  await expect(reply(turn)).toContainText('Could not get an answer');
  await expect(turn.locator('.chip')).toHaveText(['Retry', 'File instead', 'Discard']);
  expect(asks.count()).toBe(1);

  await turn.getByRole('button', { name: 'Retry' }).click();
  await expect.poll(() => asks.count()).toBe(2); // nothing edited: the same question is asked again
  await expect(reply(turn)).toHaveClass(/tone-failed/);
  const stored = (await api<{ captures: Capture[] }>(page, 'GET', '/api/captures?limit=50')).json;
  expect(stored.captures.find((c) => c.id === id)?.status).toBe('asked');

  await turn.getByRole('button', { name: 'File instead' }).click();
  await expect(reply(turn)).toContainText('What is this?');
  await turn.getByRole('button', { name: 'Note', exact: true }).click();
  await expect(reply(turn)).toContainText('Saved as a note');
});

test('Delete answer discards the answer', async ({ page }) => {
  await seedNote(page, 'qadelete a thing to find', { title: 'Qa delete note' });
  const { turn } = await ask(page, '/ask qadelete?');
  await expect(reply(turn)).toContainText('Found');
  await turn.getByRole('button', { name: 'Delete answer' }).click();
  await expect(reply(turn)).toContainText('Discarded');
  await expect(turn.locator('.chip')).toHaveCount(0);
});

test('deleting a cited note removes the answer after a reload', async ({ page }) => {
  const note = await seedNote(page, 'qagone the secret plan is blue', { title: 'Qa gone note' });
  const { turn, id } = await ask(page, '/ask qagone?');
  await expect(reply(turn)).toContainText('Found 1 item(s): Qa gone note');

  expect((await api(page, 'DELETE', `/api/notes/${note.id}`)).status).toBe(204);
  await page.reload();
  await expect(page.locator(sel.stream)).toBeVisible();
  const again = turnById(page, id);
  await expect(again).toBeVisible();
  await expect(reply(again)).toHaveClass(/tone-removed/);
  await expect(reply(again)).toContainText('removed');
  await expect(again).not.toContainText('Qa gone note');
  await expect(again).not.toContainText('secret plan');
  await expect(again.locator('.answer-sources')).toHaveCount(0);
  await expect(again.locator('.chip')).toHaveText(['Delete answer']);
});

test('reloading with an asked capture sends no ask request by itself', async ({ page }) => {
  await seedNote(page, 'qareload a note that matches', { title: 'Qa reload note' });
  // Create the asked capture through the API only: the page never sent it, so it must not ask for it.
  const made = await api<Capture>(page, 'POST', '/api/captures', { text: '/ask qareload?', source: 'text' });
  expect(made.status).toBe(201);
  expect(made.json.status).toBe('asked');
  const asks = countAsks(page);
  await page.reload();
  await expect(page.locator(sel.stream)).toBeVisible();
  const t = turnById(page, made.json.id);
  await expect(t).toBeVisible();
  await expect(reply(t)).toContainText('has not been answered yet');
  await expect(t.locator('.chip')).toHaveText(['Answer', 'File instead', 'Discard']);
  await page.waitForTimeout(700);
  expect(asks.count()).toBe(0);

  await t.getByRole('button', { name: 'Answer' }).click(); // only the user's click asks
  await expect(reply(t)).toContainText('Found 1 item(s): Qa reload note');
  expect(asks.count()).toBe(1);
});

test('at 390 px the answer, its sources and the composer are readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedNote(page, 'qaphone a note with a rather long title for a narrow screen', {
    title: 'Qa phone note with a very long title that has to fit on a narrow phone screen without scrolling sideways',
  });
  const { turn } = await ask(page, '/ask qaphone?');
  await expect(reply(turn)).toContainText('Found 1 item(s)');
  const chip = turn.locator('.answer-sources .chip').first();
  await expect(chip).toBeVisible();
  await expect(turn.getByRole('button', { name: 'Delete answer' })).toBeVisible();
  await expect(composer(page)).toBeVisible();
  expect(await noHorizontalOverflow(page)).toBe(true);
  const box = await chip.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBe(true);
  await chip.click();
  await expect(page).toHaveURL(/#\/notes\/\d+$/);
  await expect(page.locator(sel.panel)).toBeVisible();
});
