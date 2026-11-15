import { useLayoutEffect, useRef } from 'preact/hooks';
import { focusTarget } from '../lib/focus.ts';
import { goToComposer, sidebarOpen, singlePanel, toggleSidebar } from '../lib/layout.ts';
import { useKeys } from '../lib/keys.ts';
import { KEY_COMPOSER, KEY_COMPOSER_ALT, KEY_ESC, KEY_SIDEBAR } from '../lib/keymap.ts';
import { openDoc } from '../lib/nav.ts';
import type { DocRef } from '../lib/nav.ts';
import { route } from '../lib/router.ts';
import type { RouteName } from '../lib/router.ts';
import { logout, openPalette, session, toggleHelp } from '../lib/store.ts';
import { SidebarLists } from './SidebarLists.tsx';

const ITEMS: { ref: DocRef; label: string; icon: string; names: RouteName[] }[] = [
  { ref: { kind: 'actions' }, label: 'Actions', icon: '☐', names: ['actions'] },
  { ref: { kind: 'notes' }, label: 'Notes', icon: '✎', names: ['notes', 'note'] },
  { ref: { kind: 'people' }, label: 'People', icon: '☺', names: ['people', 'person', 'meeting'] },
  { ref: { kind: 'projects' }, label: 'Projects', icon: '▣', names: ['projects', 'project'] },
];

/**
 * Sidebar: + New, Search, the four lists, then Pinned and Recents (SidebarLists), footer. On narrow
 * screens it is a drawer: a modal key layer while open (Esc closes it), closes on navigation.
 */
export function Sidebar() {
  const el = useRef<HTMLElement>(null);
  const drawer = singlePanel.value;
  const open = sidebarOpen.value;
  const drawerOpen = drawer && open;
  // After a 401 the shell stays mounted (inert) behind the Login curtain: its drawer layer must not answer keys then.
  const keysOn = drawerOpen && session.value !== null;
  const closeDrawer = () => { sidebarOpen.value = false; focusTarget('composer', { queue: false }); };
  // The drawer is a modal layer, so the shortcuts that make sense with it open are bound here too.
  useKeys({
    [KEY_ESC]: closeDrawer,
    [KEY_SIDEBAR]: closeDrawer,
    [KEY_COMPOSER]: goToComposer, // closes the drawer itself, then focuses the composer
    [KEY_COMPOSER_ALT]: goToComposer,
  }, { scope: 'modal', enabled: keysOn });
  // Focus moves into the drawer synchronously when it opens, so the next key does not act on the page behind.
  useLayoutEffect(() => { if (drawerOpen) el.current?.focus(); }, [drawerOpen]);
  const current = route.value.name;

  return (
    <>
      {drawerOpen && <div class="scrim" onClick={closeDrawer} aria-hidden="true" />}
      <nav class="sidebar" aria-label="Sidebar" ref={el} tabIndex={-1} aria-hidden={drawer && !open ? 'true' : undefined}>
        <div class="sidebar-head">
          <span class="brand">XO</span>
          <button type="button" class="icon-btn" aria-label="Hide sidebar" title="Hide sidebar (Cmd-B)" onClick={toggleSidebar}>‹</button>
        </div>
        <div class="sidebar-scroll">
          <button type="button" class="side-item" onClick={goToComposer}>
            <span class="side-icon" aria-hidden="true">+</span><span>New</span><span class="hint" aria-hidden="true">⌘J</span>
          </button>
          <button type="button" class="side-item" onClick={() => { if (drawer) { sidebarOpen.value = false; setTimeout(openPalette, 0); } else openPalette(); }}>
            <span class="side-icon" aria-hidden="true">⌕</span><span>Search</span><span class="hint" aria-hidden="true">⌘K</span>
          </button>
          {ITEMS.map((it) => (
            <a
              key={it.label} class="side-item" href={`#/${it.label.toLowerCase()}`}
              aria-current={it.names.includes(current) ? 'page' : undefined}
              onClick={(e) => { e.preventDefault(); openDoc(it.ref); }}
            >
              <span class="side-icon" aria-hidden="true">{it.icon}</span><span>{it.label}</span>
            </a>
          ))}
          <SidebarLists />
        </div>
        <div class="side-foot">
          <button type="button" class="side-item" onClick={toggleHelp}>
            <span class="side-icon" aria-hidden="true">?</span><span>Shortcuts</span>
          </button>
          <button type="button" class="side-item" onClick={() => { void logout(); }}>
            <span class="side-icon" aria-hidden="true">⎋</span><span>Log out</span>
          </button>
        </div>
      </nav>
    </>
  );
}
