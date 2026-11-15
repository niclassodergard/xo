import { expect, EXPECTED_401, loginWithKeyboard, mouseCount, noHorizontalOverflow, seedPerson, sel, test } from './helpers.ts';
import type { Page } from '@playwright/test';

// Browser check for step C1: the shell (sidebar, chat column, panel), the key engine, the component kit,
// theme, phone layout and the session lock. Documents are stubs here; the List/TextEdit check uses the
// e2e-only #/kit document.

const composer = (page: Page) => page.locator(sel.composer);
const panel = (page: Page) => page.locator(sel.panel);
const palette = (page: Page) => page.locator(sel.palette);

async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe('login', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('logs in with the keyboard only; nothing is kept in web storage', async ({ page, diag }) => {
    diag.allow(EXPECTED_401); // the session check of a logged-out browser
    await page.goto('/');
    await loginWithKeyboard(page);
    await expect(composer(page)).toBeVisible();
    await expect(page.locator(sel.sidebar)).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).toBe('{}');
    // Only UI preferences (no user data, no token) may be in localStorage.
    const keys = await page.evaluate(() => Object.keys(localStorage));
    expect(keys.filter((k) => !k.startsWith('xo.ui.'))).toEqual([]);
  });
});

test.describe('shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
  });

  test('sidebar items open their documents in the panel', async ({ page }) => {
    const side = page.locator(sel.sidebar);
    for (const name of ['Actions', 'Notes', 'People', 'Projects']) {
      await side.getByRole('link', { name, exact: true }).click();
      await expect(panel(page).getByRole('heading', { name })).toBeVisible();
      await expect(side.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page).toHaveURL(new RegExp(`#/${name.toLowerCase()}$`));
      // Split view: chat and panel side by side.
      await expect(composer(page)).toBeVisible();
    }
    await page.goBack();
    await expect(panel(page).getByRole('heading', { name: 'People' })).toBeVisible();
  });

  test('+ New focuses the composer and Search opens the palette', async ({ page }) => {
    const side = page.locator(sel.sidebar);
    await side.getByRole('button', { name: /^New/ }).click();
    await expect(composer(page)).toBeFocused();
    await side.getByRole('button', { name: /^Search/ }).click();
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
  });

  test('the panel expands, collapses and closes with Esc, focus returning to the composer', async ({ page }) => {
    await page.locator(sel.sidebar).getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Expand document' }).click();
    await expect(page.locator('.app')).toHaveAttribute('data-expanded', 'true');
    await expect(composer(page)).toHaveCount(0); // the chat column is not rendered while expanded
    await panel(page).getByRole('button', { name: 'Collapse document' }).click();
    await expect(composer(page)).toBeVisible();
    await expect(page.locator('.app')).toHaveAttribute('data-expanded', 'false');

    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await expect(page).toHaveURL(/\/(#\/)?$/);

    // Esc with the composer focused and nothing open does nothing more.
    await page.keyboard.press('Escape');
    await expect(composer(page)).toBeFocused();
  });

  test('Cmd-K opens the palette with the input focused; the first typed characters land in it', async ({ page }) => {
    await blurActive(page);
    await page.keyboard.press('Meta+k');
    const input = palette(page).getByRole('combobox');
    await expect(input).toBeFocused();
    await page.keyboard.type('go to pro'); // typed at once, no wait
    await expect(input).toHaveValue('go to pro');
    await expect(palette(page).getByRole('option', { name: 'Go to Projects' })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(palette(page)).toHaveCount(0);
    await expect(panel(page).getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.keyboard.press('Control+k'); // Ctrl-K works too
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Control+k'); // and toggles it closed
    await expect(palette(page)).toHaveCount(0);
  });

  test('Cmd-K is a no-op under a Prompt; "Start 1-1 with…" picks a person', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('new person');
    await page.keyboard.press('Enter');
    const prompt = page.getByRole('dialog', { name: 'New person' });
    await expect(prompt).toBeVisible();
    const field = prompt.getByRole('textbox');
    await expect(field).toBeFocused();
    await page.keyboard.type('shell Bo');
    await page.keyboard.press('Meta+k');
    await expect(palette(page)).toHaveCount(0);
    await expect(prompt).toBeVisible();
    await expect(field).toHaveValue('shell Bo'); // typing was not lost
    await page.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);

    const anna = await seedPerson(page, `shell Anna ${Date.now() % 100000}`);
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('start 1-1');
    await page.keyboard.press('Enter');
    const picker = page.getByRole('dialog', { name: 'Pick person' });
    await expect(picker.getByRole('combobox')).toBeFocused();
    await page.keyboard.type(anna.name.toLowerCase());
    await expect(picker.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: /^1-1 ·/, level: 2 })).toBeVisible();
    await expect(page).toHaveURL(/#\/meetings\/\d+$/);
  });

  test('the palette command "Shortcuts" opens the help', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('shortcuts');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toHaveCount(0);
  });

  test('Esc and Close never leave a history entry that reopens the closed document', async ({ page }) => {
    const depth = () => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0);
    // Opened from home: closing goes back in history, to the entry the app started on.
    await page.locator(sel.sidebar).getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    expect(await depth()).toBe(1);
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/(#\/)?$/);
    expect(await depth()).toBe(0);
    await page.locator(sel.sidebar).getByRole('link', { name: 'Notes', exact: true }).click();
    await panel(page).getByRole('button', { name: 'Close document' }).click();
    await expect(page).toHaveURL(/\/(#\/)?$/);
    expect(await depth()).toBe(0);

    // Opened from another document: closing replaces the entry, so Back lands on the first document only.
    await page.goto('/#/people');
    await expect(panel(page).getByRole('heading', { name: 'People' })).toBeVisible();
    await page.locator(sel.sidebar).getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(panel(page).getByRole('heading', { name: 'Projects' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/(#\/)?$/);
    await page.goBack();
    await expect(page).toHaveURL(/#\/people$/);
  });

  test('Option+character types into the composer (@ on a Swedish Mac)', async ({ page }) => {
    await blurActive(page);
    await page.keyboard.down('Alt');
    await page.keyboard.press('@');
    await page.keyboard.up('Alt');
    await expect(composer(page)).toBeFocused();
  });

  test('Cmd-J focuses the composer from anywhere', async ({ page }) => {
    await page.locator(sel.sidebar).getByRole('link', { name: 'Notes', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await blurActive(page);
    await page.keyboard.press('Meta+j');
    await expect(composer(page)).toBeFocused();
    await expect(panel(page)).toBeVisible(); // the document stays open on desktop
    await panel(page).focus();
    await page.keyboard.press('Control+j');
    await expect(composer(page)).toBeFocused();
    // Cmd-N is best effort (the browser may keep it); where the page sees it, it does the same.
    await page.locator(sel.sidebar).focus();
    await page.keyboard.press('Meta+n');
    await expect(composer(page)).toBeFocused();
  });

  test('a letter typed with focus on the page body lands in the composer', async ({ page }) => {
    await blurActive(page);
    await page.keyboard.type('hej då');
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('hej då');
    await composer(page).fill('');
    // Not while a dialog is open.
    await page.keyboard.press('Meta+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(composer(page)).toHaveValue('');
  });

  test('Cmd-B toggles the sidebar (and the preference survives a reload)', async ({ page }) => {
    const side = page.locator(sel.sidebar);
    await expect(side).toBeVisible();
    await page.keyboard.press('Meta+b');
    await expect(side).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
    await page.reload();
    await expect(composer(page)).toBeVisible();
    await expect(side).toBeHidden();
    await page.keyboard.press('Meta+b');
    await expect(side).toBeVisible();
  });

  test('Shortcuts opens the help from the keymap and Esc closes it', async ({ page }) => {
    await page.locator(sel.sidebar).getByRole('button', { name: 'Shortcuts' }).click();
    const help = page.getByRole('dialog', { name: 'Shortcuts' });
    await expect(help).toBeVisible();
    await expect(help).toContainText('Search and commands');
    await expect(help).toContainText('Option-Space');
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
  });

  test('keyboard only: palette, panel, Esc, Cmd-J, Cmd-B with zero mouse events', async ({ page }) => {
    await page.keyboard.press('Meta+k');
    await page.keyboard.type('go to act');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: 'Actions' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
    await page.keyboard.press('Meta+b');
    await page.keyboard.press('Meta+b');
    await blurActive(page);
    await page.keyboard.press('Meta+j');
    await expect(composer(page)).toBeFocused();
    expect(await mouseCount(page)).toBe(0);
  });
});

test.describe('component kit (#/kit, e2e build only)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/kit');
    await expect(composer(page)).toBeVisible();
    test.skip(await page.getByRole('listbox', { name: 'Kit list' }).count() === 0, 'needs the e2e client build (XO_E2E_SKIP_BUILD serves a production build)');
  });

  test('List: arrows pick rows and chips, Enter runs, danger asks, add field', async ({ page }) => {
    const list = page.getByRole('listbox', { name: 'Kit list' });
    const last = page.locator('#kit-last');
    const rows = list.getByRole('option');
    await expect(rows).toHaveCount(3);

    // Down from the panel container moves into the first list.
    await panel(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(list).toBeFocused();
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true'); // first row highlighted on entry
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'false');
    await expect(list).toHaveAttribute('aria-activedescendant', (await rows.nth(1).getAttribute('id'))!);
    await expect(page.locator('.list-wrap [role="status"]')).toContainText('Row two'); // announced

    // Enter runs the default (first) action; focus stays on the list (no native roving focus).
    await page.keyboard.press('Enter');
    await expect(last).toHaveText('last: toggle Row two');
    await expect(list).toBeFocused();

    // Right picks chips (clamped), Enter runs the highlighted one.
    await page.keyboard.press('ArrowRight'); // first chip
    await page.keyboard.press('ArrowRight'); // Rename
    await expect(rows.nth(1).getByRole('button', { name: 'Rename' })).toHaveClass(/highlighted/);
    await page.keyboard.press('Enter');
    await expect(last).toHaveText('last: rename Row two');
    await page.keyboard.press('ArrowLeft');
    await expect(rows.nth(1).getByRole('button', { name: 'Toggle' })).toHaveClass(/highlighted/);

    // A danger chip always asks first; Esc cancels and the row stays.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: 'Confirm' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('Row two');
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(rows).toHaveCount(3);
    await expect(last).toHaveText('last: rename Row two');

    // Confirm with Yes: only then is it deleted, and focus returns to the list.
    await list.focus();
    await page.keyboard.press('Enter'); // still on the Delete chip
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Yes' }).click();
    await expect(rows).toHaveCount(2);
    await expect(last).toHaveText('last: delete Row two');
    // The highlight moved to the neighbouring row (Row three took its place).
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(rows.nth(1)).toContainText('Row three');

    // Down past the last row focuses the add field; a failed add keeps the text; Up on an empty field returns.
    await list.focus();
    await page.keyboard.press('ArrowDown');
    const add = page.getByRole('textbox', { name: 'Add a row' });
    await expect(add).toBeFocused();
    await page.keyboard.type('fail');
    await page.keyboard.press('Enter');
    await expect(add).toHaveValue('fail');
    await add.fill('Row new');
    await page.keyboard.press('Enter');
    await expect(rows).toHaveCount(3);
    await expect(add).toHaveValue('');
    await page.keyboard.press('ArrowUp');
    await expect(list).toBeFocused();
    await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
  });

  test('add-field text belongs to its entity (draftId), not to the list label', async ({ page }) => {
    const add = page.getByRole('textbox', { name: 'Add a row' });
    const sw = page.getByRole('button', { name: /Switch entity/ });
    await add.fill('for entity one');
    await sw.click();
    await expect(sw).toContainText('now 2');
    await expect(add).toHaveValue('');
    await add.fill('for entity two');
    await sw.click();
    await expect(add).toHaveValue('for entity one');
    await add.fill('');
    await sw.click();
    await add.fill('');
  });

  test('Down in an empty list reaches the add field; a held Enter does not repeat an action', async ({ page }) => {
    const list = page.getByRole('listbox', { name: 'Kit list' });
    const rows = list.getByRole('option');
    const last = page.locator('#kit-last');
    await list.focus();
    await page.keyboard.press('Enter'); // first row, first action
    await expect(last).toHaveText('last: toggle Row one');
    await page.evaluate(() => { document.querySelector('#kit-last')!.setAttribute('data-n', '0'); });
    // A repeated Enter (auto-repeat) must not run anything.
    await page.evaluate(() => {
      const el = document.querySelector('[role=listbox][aria-label="Kit list"]') as HTMLElement;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true, bubbles: true, cancelable: true }));
    });
    await expect(last).toHaveText('last: toggle Row one');
    // Delete every row (Right x3 = Delete chip, Enter, confirm), then Down reaches the add field.
    for (let n = await rows.count(); n > 0; n--) {
      await list.focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
      await expect(rows.first().getByRole('button', { name: 'Delete' })).toHaveClass(/highlighted/);
      await page.keyboard.press('Enter');
      await page.getByRole('dialog', { name: 'Confirm' }).getByRole('button', { name: 'Yes' }).click();
      await expect(rows).toHaveCount(n - 1);
    }
    await expect(page.getByText('No rows.')).toBeVisible();
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('textbox', { name: 'Add a row' })).toBeFocused();
  });

  test('stray typing in a list goes to the composer and runs nothing', async ({ page }) => {
    await panel(page).focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('listbox', { name: 'Kit list' })).toBeFocused();
    await page.keyboard.type('d');
    await expect(composer(page)).toBeFocused();
    await expect(composer(page)).toHaveValue('d');
    await expect(page.locator('#kit-last')).toHaveText('last: none');
    await composer(page).fill('');
  });

  test('Esc leaves a panel field (it saves), the next Esc closes the document', async ({ page }) => {
    const field = page.getByRole('textbox', { name: 'Kit text' });
    await field.focus();
    await page.keyboard.type('draft');
    await page.keyboard.press('Escape');
    await expect(field).not.toBeFocused();
    await expect(panel(page)).toBeFocused();
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(composer(page)).toBeFocused();
  });
});

test.describe('narrow desktop (960 px)', () => {
  test('sidebar and a document fit without horizontal overflow', async ({ page }) => {
    for (const width of [900, 960, 1019, 1020]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/#/projects');
      await expect(panel(page)).toBeVisible();
      await expect(page.locator(sel.sidebar)).toBeVisible();
      await expect(composer(page)).toBeVisible();
      expect(await noHorizontalOverflow(page), `${width}px`).toBe(true);
    }
  });
});

test.describe('theme', () => {
  function luminance(rgb: string): number {
    const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => {
      const c = (v ?? 0) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };

  test('light and dark follow the system; text meets 4.5:1 in both', async ({ page }) => {
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
    const read = () => page.evaluate(() => {
      const css = (el: Element, p: string) => getComputedStyle(el).getPropertyValue(p).trim();
      // A probe element for the muted text token (works whatever the stream renders).
      const probe = document.createElement('span');
      probe.className = 'muted';
      probe.textContent = 'probe';
      document.body.appendChild(probe);
      const muted = getComputedStyle(probe).color;
      probe.remove();
      const body = getComputedStyle(document.body);
      const side = getComputedStyle(document.querySelector('nav[aria-label="Sidebar"]')!);
      return {
        bg: body.backgroundColor, fg: body.color, sidebar: side.backgroundColor, font: body.fontFamily, size: body.fontSize,
        scheme: css(document.documentElement, '--bg'), muted,
      };
    });
    await page.emulateMedia({ colorScheme: 'light' });
    const light = await read();
    await page.emulateMedia({ colorScheme: 'dark' });
    const dark = await read();
    expect(light.scheme).toBe('#faf9f5');
    expect(dark.scheme).toBe('#262624');
    expect(light.bg).not.toBe(dark.bg);
    expect(light.sidebar).not.toBe(dark.sidebar);
    for (const t of [light, dark]) {
      expect(contrast(t.fg, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted, t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.fg, t.sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(t.size).toBe('16px');
      expect(t.font).not.toMatch(/mono/i);
    }
  });
});

test.describe('phone width (390 px)', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(composer(page)).toBeVisible();
  });

  test('drawer, one panel at a time, back button, nothing wider than the viewport', async ({ page }) => {
    const side = page.locator(sel.sidebar);
    await expect(side).toBeHidden(); // the drawer starts closed
    expect(await noHorizontalOverflow(page)).toBe(true);
    await expect(page.locator('body')).toHaveCSS('font-size', '17px');
    expect(await composer(page).evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);

    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(side).toBeVisible();
    expect(await noHorizontalOverflow(page)).toBe(true);
    await page.keyboard.press('Escape'); // Esc closes the drawer
    await expect(side).toBeHidden();

    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await side.getByRole('link', { name: 'Projects', exact: true }).click();
    await expect(side).toBeHidden(); // closes on navigation
    await expect(panel(page).getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(composer(page)).toHaveCount(0); // one panel at a time
    expect(await noHorizontalOverflow(page)).toBe(true);

    await panel(page).getByRole('button', { name: 'Back' }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(composer(page)).toBeVisible();

    // Cmd-J from a document goes to the chat first.
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await side.getByRole('link', { name: 'People', exact: true }).click();
    await expect(panel(page)).toBeVisible();
    await blurActive(page);
    await page.keyboard.press('Meta+j');
    await expect(composer(page)).toBeVisible();
    await expect(composer(page)).toBeFocused();
    await expect(panel(page)).toHaveCount(0);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test('Cmd-B and Cmd-J / Cmd-N work with the drawer open', async ({ page }) => {
    const side = page.locator(sel.sidebar);
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(side).toBeVisible();
    await page.keyboard.press('Meta+b');
    await expect(side).toBeHidden();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await page.keyboard.press('Meta+j');
    await expect(side).toBeHidden();
    await expect(composer(page)).toBeFocused();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await page.keyboard.press('Meta+n');
    await expect(side).toBeHidden();
    await expect(composer(page)).toBeFocused();
  });

  test('the composer stays pinned at the bottom and the mic button is reachable', async ({ page }) => {
    const box = await composer(page).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    expect(box!.y + box!.height).toBeGreaterThan(844 - 120);
    const mic = page.locator(sel.mic);
    await expect(mic).toBeVisible();
    const m = await mic.boundingBox();
    expect(m!.x + m!.width).toBeLessThanOrEqual(390);
    expect(m!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('session lock', () => {
  test('a killed session unmounts the stream and the panel, and only the typed draft survives', async ({ sparePage, diag }) => {
    diag.allow(EXPECTED_401);
    const page = await sparePage(1);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/#/actions');
    await expect(panel(page)).toBeVisible();
    await expect(page.locator(sel.stream)).toBeVisible();
    await composer(page).fill('half typed thought');

    // End the session on the server, then let the app notice (it re-checks when the window gets focus).
    await page.evaluate(async () => {
      const s = (await (await fetch('/api/auth/session')).json()) as { csrfToken: string };
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-xo-csrf': s.csrfToken } });
      window.dispatchEvent(new Event('focus'));
    });
    await expect(page.locator('input[type=password]')).toBeVisible();
    await expect(page.locator(sel.stream)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    await expect(composer(page)).toHaveCount(0);
    // The shell behind the curtain is inert and hidden from assistive technology.
    await expect(page.locator('.app')).toHaveAttribute('aria-hidden', 'true');
    expect(await page.locator('.app').evaluate((el) => (el as HTMLElement).inert)).toBe(true);

    // After a fresh login the draft is back.
    await loginWithKeyboard(page);
    await expect(composer(page)).toHaveValue('half typed thought');
    await composer(page).fill('');
  });
});
