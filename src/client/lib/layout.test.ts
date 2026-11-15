import { afterEach, describe, expect, it } from 'vitest';
import { resetFocusTargets } from './focus.ts';
import {
  chatVisible, escAction, goToComposer, isSinglePanelWidth, panelExpanded, sidebarOpen, singlePanel, toggleSidebar,
} from './layout.ts';
import { navigate } from './router.ts';

afterEach(() => { singlePanel.value = false; panelExpanded.value = false; sidebarOpen.value = true; navigate('/'); resetFocusTargets(); });

describe('breakpoint', () => {
  it('is single-panel below 900 px', () => {
    expect(isSinglePanelWidth(899)).toBe(true);
    expect(isSinglePanelWidth(390)).toBe(true);
    expect(isSinglePanelWidth(900)).toBe(false);
    expect(isSinglePanelWidth(1440)).toBe(false);
  });
});

describe('chatVisible', () => {
  it('the chat column is rendered unless a document replaces it (single-panel or expanded)', () => {
    expect(chatVisible(false, true, false)).toBe(true);
    expect(chatVisible(false, false, true)).toBe(true);
    expect(chatVisible(true, false, false)).toBe(true);
    expect(chatVisible(true, true, false)).toBe(false);
    expect(chatVisible(true, false, true)).toBe(false);
  });
});

describe('escAction', () => {
  it('a text field in the panel is left first, then the panel closes, then the composer is focused', () => {
    expect(escAction({ textEntryInPanel: true, panelOpen: true })).toBe('blur-field');
    expect(escAction({ textEntryInPanel: false, panelOpen: true })).toBe('close-panel');
    expect(escAction({ textEntryInPanel: false, panelOpen: false })).toBe('focus-composer');
  });
});

describe('goToComposer', () => {
  it('single-panel mode with a document open goes back to the chat and closes the drawer', async () => {
    const { route } = await import('./router.ts');
    singlePanel.value = true;
    navigate('/people/2');
    sidebarOpen.value = true;
    goToComposer();
    expect(route.value.name).toBe('home');
    expect(sidebarOpen.value).toBe(false);
  });
  it('an expanded desktop panel is collapsed', () => {
    navigate('/projects');
    panelExpanded.value = true;
    goToComposer();
    expect(panelExpanded.value).toBe(false);
  });
});

describe('sidebar', () => {
  it('toggles', () => {
    sidebarOpen.value = true;
    toggleSidebar();
    expect(sidebarOpen.value).toBe(false);
    toggleSidebar();
    expect(sidebarOpen.value).toBe(true);
  });
  it('the drawer closes on navigation in single-panel mode only', async () => {
    singlePanel.value = true;
    sidebarOpen.value = true;
    navigate('/notes');
    await Promise.resolve();
    expect(sidebarOpen.value).toBe(false);
    singlePanel.value = false;
    sidebarOpen.value = true;
    navigate('/people');
    await Promise.resolve();
    expect(sidebarOpen.value).toBe(true);
  });
});
