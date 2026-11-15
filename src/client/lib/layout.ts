import { effect, signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { focusTarget } from './focus.ts';
import { isPanelRoute, navigate, route } from './router.ts';

// Layout state. Only UI preferences are kept in localStorage (no user data): whether the panel is
// expanded and whether the desktop sidebar is open.

/** Viewport narrower than this is "single-panel mode" (drawer sidebar; chat or document, not both). */
export const SINGLE_PANEL_BELOW_PX = 900;
export function isSinglePanelWidth(widthPx: number): boolean { return widthPx < SINGLE_PANEL_BELOW_PX; }

const KEY_EXPANDED = 'xo.ui.panelExpanded';
const KEY_SIDEBAR = 'xo.ui.sidebarOpen';

function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = typeof window === 'undefined' ? null : window.localStorage?.getItem(key) ?? null;
    return v === null ? fallback : v === '1';
  } catch { return fallback; }
}
function writePref(key: string, value: boolean): void {
  try { if (typeof window !== 'undefined') window.localStorage?.setItem(key, value ? '1' : '0'); } catch { /* private mode */ }
}

const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia(`(max-width: ${SINGLE_PANEL_BELOW_PX - 0.02}px)`) : null;

/** Viewport < 900 px. */
export const singlePanel: Signal<boolean> = signal(mq ? mq.matches : false);
/** The panel takes the whole main area (desktop only; ignored while no document is open). Remembered. */
export const panelExpanded: Signal<boolean> = signal(readPref(KEY_EXPANDED, false));
/** Desktop: the sidebar column is shown (remembered). Single-panel mode: the drawer is open (never remembered, starts closed). */
export const sidebarOpen: Signal<boolean> = signal(singlePanel.value ? false : readPref(KEY_SIDEBAR, true));

if (mq) {
  mq.addEventListener('change', (e) => {
    singlePanel.value = e.matches;
    sidebarOpen.value = e.matches ? false : readPref(KEY_SIDEBAR, true);
  });
}

effect(() => { writePref(KEY_EXPANDED, panelExpanded.value); });
effect(() => {
  const open = sidebarOpen.value;
  if (!singlePanel.peek()) writePref(KEY_SIDEBAR, open);
});
// The drawer closes on every navigation.
effect(() => {
  void route.value;
  if (singlePanel.peek()) sidebarOpen.value = false;
});

export function toggleSidebar(): void { sidebarOpen.value = !sidebarOpen.value; }
export function toggleExpanded(): void { panelExpanded.value = !panelExpanded.value; }

/** Whether the chat column is rendered for a route under the current layout. */
export function chatVisible(panelOpen: boolean, single: boolean, expanded: boolean): boolean {
  if (!panelOpen) return true;
  return !(single || expanded);
}

/**
 * "New capture": make the composer visible and focus it. Single-panel mode with a document open goes to the
 * chat first; an expanded panel is collapsed. The composer may not be rendered yet, so the focus request
 * is queued (see lib/focus.ts).
 */
export function goToComposer(): void {
  const open = isPanelRoute(route.peek());
  if (open && singlePanel.peek()) navigate('/');
  else if (open && panelExpanded.peek()) panelExpanded.value = false;
  if (singlePanel.peek()) sidebarOpen.value = false;
  focusTarget('composer');
}

export type EscAction = 'blur-field' | 'close-panel' | 'focus-composer';

/**
 * What the global Esc does once no overlay (and no recording) took it: leave a text field inside the panel
 * (the field saves on blur); else close the open document; else focus the composer.
 */
export function escAction(o: { textEntryInPanel: boolean; panelOpen: boolean }): EscAction {
  if (o.textEntryInPanel) return 'blur-field';
  return o.panelOpen ? 'close-panel' : 'focus-composer';
}
