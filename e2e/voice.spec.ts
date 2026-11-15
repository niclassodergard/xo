import { expect, mouseCount, noHorizontalOverflow, seedPerson, sel, test } from './helpers.ts';
import type { Page } from '@playwright/test';
import type { Person } from '../src/shared/types.ts';

// Browser check for step C7: voice in the new shell. Chromium runs with a fake microphone (playwright.config.ts)
// and the server with the fake transcriber, which always answers "open Anna". The person is therefore seeded with
// the alias "Anna" (an exact alias beats first-name matches of other specs' people). The dictation test replaces
// the transcript through a route handler (no server-side change).

const mic = (page: Page) => page.locator(sel.mic);
const composer = (page: Page) => page.locator(sel.composer);
const panel = (page: Page) => page.locator(sel.panel);
const RECORDING = /recording/;
const IDLE = /hold Option-Space/;

// One person for the whole file: a second one with the alias "Anna" would make "open Anna" ambiguous.
let anna: Promise<Person> | null = null;
async function seedAnna(page: Page): Promise<Person> {
  await page.goto('/');
  await expect(composer(page)).toBeVisible();
  if (anna === null) {
    anna = seedPerson(page, `voice Zed ${Date.now().toString(36)}`, ['Anna']);
    await anna;
    await page.reload(); // the client loads its people list at start: it must see the new person
    await expect(composer(page)).toBeVisible();
  }
  return anna;
}

test.describe('voice', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  test('the mic button toggles a recording and the spoken command opens the person', async ({ page }) => {
    const anna = await seedAnna(page);
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700); // longer than the minimum recording length
    const upload = page.waitForResponse((r) => r.url().endsWith('/api/voice/transcribe'));
    await mic(page).click();
    expect((await upload).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`#/people/${anna.id}$`));
    await expect(panel(page)).toBeVisible();
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
  });

  test('hold Option-Space with the composer focused records, and releasing transcribes', async ({ page }) => {
    const anna = await seedAnna(page);
    await composer(page).click();
    await expect(composer(page)).toBeFocused();
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.waitForTimeout(700);
    const upload = page.waitForResponse((r) => r.url().endsWith('/api/voice/transcribe'));
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    expect((await upload).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`#/people/${anna.id}$`));
    await expect(composer(page)).toHaveValue(''); // no space or other character leaked into the field
  });

  test('dictation is appended to the composer draft and keeps the focus there', async ({ page }) => {
    await page.route('**/api/voice/transcribe', (route) => route.fulfill({ json: { text: 'buy oat milk' } }));
    await page.goto('/');
    await composer(page).fill('voice note:');
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.waitForTimeout(700);
    await mic(page).click();
    await expect(composer(page)).toHaveValue('voice note: buy oat milk');
    await expect(composer(page)).toBeFocused();
  });

  test('Esc during a recording cancels it and the open panel stays open', async ({ page }) => {
    const anna = await seedAnna(page);
    await page.goto(`/#/people/${anna.id}`);
    await expect(panel(page)).toBeVisible();
    let uploads = 0;
    page.on('request', (r) => { if (r.url().endsWith('/api/voice/transcribe')) uploads++; });
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.keyboard.press('Escape');
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
    await expect(panel(page)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`#/people/${anna.id}$`));
    await page.waitForTimeout(300);
    expect(uploads).toBe(0);
  });

  test('a second Esc, with nothing recording, still closes the panel (the voice layer is gone)', async ({ page }) => {
    const anna = await seedAnna(page);
    await page.goto(`/#/people/${anna.id}`);
    await expect(panel(page)).toBeVisible();
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.keyboard.press('Escape');
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
  });

  test('at the limit the Send/Discard prompt shows, and Enter sends the recording, not the draft', async ({ page }) => {
    await page.clock.install();
    const anna = await seedAnna(page);
    await composer(page).fill('my unsent draft');
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await composer(page).click(); // the draft field has focus while the limit is reached
    await expect(composer(page)).toBeFocused();
    await page.clock.fastForward(121_000);
    const prompt = page.locator('.voice-status.confirm');
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole('button', { name: /^Send/ })).toBeVisible();
    await expect(prompt.getByRole('button', { name: /^Discard/ })).toBeVisible();
    const p = (await prompt.boundingBox())!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(1280);
    let sends = 0;
    page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/captures') sends++; });
    const upload = page.waitForResponse((r) => r.url().endsWith('/api/voice/transcribe'));
    await page.keyboard.press('Enter');
    expect((await upload).status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`#/people/${anna.id}$`));
    await expect(composer(page)).toHaveValue('my unsent draft');
    expect(sends).toBe(0); // the recording upload above did happen, but the draft was never sent as a capture
    // The counter really sees capture sends: sending the draft by hand registers exactly one.
    await composer(page).click();
    await page.keyboard.press('Enter');
    await expect.poll(() => sends).toBe(1);
  });

  test('with the panel expanded (no composer on screen) the recording indicator is still visible', async ({ page }) => {
    const anna = await seedAnna(page);
    await page.goto(`/#/people/${anna.id}`);
    await expect(panel(page)).toBeVisible();
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.getByRole('button', { name: 'Expand document' }).click();
    await expect(composer(page)).toHaveCount(0);
    await expect(page.locator('.voice-status')).toContainText('Recording');
    await expect(page.locator('.voice-status')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.voice-status')).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

  test('keyboard only: no mouse input is needed to record and cancel', async ({ page }) => {
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    // initVoice() registers its keys in an effect after the first paint: wait until the Dictate command exists
    // (it is registered together with the key bindings), or the held Option-Space below can race the app start.
    await page.keyboard.press('Meta+k');
    await expect(page.locator(sel.palette)).toBeVisible();
    await page.keyboard.type('Dictate');
    await expect(page.locator(sel.palette).getByText('Dictate (start/stop microphone)')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator(sel.palette)).toHaveCount(0);
    const before = await mouseCount(page);
    await page.keyboard.press('Meta+j');
    await page.keyboard.down('Alt');
    await page.keyboard.down('Space');
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.keyboard.press('Escape');
    await page.keyboard.up('Space');
    await page.keyboard.up('Alt');
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
    expect(await mouseCount(page)).toBe(before);
  });
});

test.describe('voice at 390 px', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test('a large mic button, and the Send/Discard prompt fits inside the viewport', async ({ page }) => {
    await page.clock.install();
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    const m = (await mic(page).boundingBox())!;
    expect(m.height).toBeGreaterThanOrEqual(56);
    expect(m.x + m.width).toBeLessThanOrEqual(390);
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.clock.fastForward(121_000);
    const prompt = page.locator('.voice-status.confirm');
    await expect(prompt).toBeVisible();
    const p = (await prompt.boundingBox())!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(390);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.height).toBeLessThanOrEqual(844);
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.keyboard.press('Escape'); // Discard
    await expect(prompt).toHaveCount(0);
    await expect(mic(page)).toHaveAttribute('aria-label', IDLE);
  });

  test('with a document open (no composer) the recording and the prompt at the limit are visible', async ({ page }) => {
    await page.clock.install();
    const anna = await seedAnna(page);
    await expect(composer(page)).toBeVisible();
    await mic(page).click();
    await expect(mic(page)).toHaveAttribute('aria-label', RECORDING);
    await page.evaluate((id) => { location.hash = `#/people/${id}`; }, anna.id);
    await expect(panel(page)).toBeVisible();
    await expect(composer(page)).toHaveCount(0);
    const status = page.locator('.voice-status');
    await expect(status).toContainText('Esc cancels');
    const sb = (await status.boundingBox())!;
    expect(sb.height).toBeLessThan(50); // one line
    // The panel header's Back button is not covered by the bar (a trial click checks the hit target).
    await page.getByRole('button', { name: 'Back' }).click({ trial: true });
    await page.clock.fastForward(121_000);
    const prompt = page.locator('.voice-status.confirm');
    await expect(prompt).toBeVisible();
    const p = (await prompt.boundingBox())!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(390);
    await expect(prompt.getByRole('button', { name: /^Send/ })).toBeVisible();
    await page.keyboard.press('Escape'); // Discard
    await expect(status).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });
});
