import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { NavItem } from '../../shared/types.ts';
import { docPath, openDoc } from '../lib/nav.ts';
import { nav } from '../lib/store.ts';
import '../styles/nav.css';

// Collapse state is a UI preference only (no user data), kept in localStorage like the other layout prefs.
function readOpen(key: string): boolean {
  try { return typeof window === 'undefined' || window.localStorage?.getItem(key) !== '0'; } catch { return true; }
}
function pref(key: string): Signal<boolean> { return signal(readOpen(key)); }
const KEY_PINNED = 'xo.ui.pinnedOpen';
const KEY_RECENTS = 'xo.ui.recentsOpen';
const pinnedOpen = pref(KEY_PINNED);
const recentsOpen = pref(KEY_RECENTS);

function toggle(s: Signal<boolean>, key: string): void {
  s.value = !s.value;
  try { window.localStorage?.setItem(key, s.value ? '1' : '0'); } catch { /* private mode */ }
}

const ICON: Record<NavItem['kind'], string> = { person: '☺', project: '▣', meeting: '☷', note: '✎' };

function Group(props: { title: string; open: Signal<boolean>; storeKey: string; items: NavItem[]; empty: string }) {
  const open = props.open.value;
  const id = `side-group-${props.title.toLowerCase()}`;
  return (
    <div class="side-group">
      <button type="button" class="side-title" aria-expanded={open} aria-controls={id} onClick={() => toggle(props.open, props.storeKey)}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span><span>{props.title}</span>
      </button>
      {open && (
        <div id={id}>
          {props.items.length === 0 && <div class="hint side-empty">{props.empty}</div>}
          {props.items.map((it) => (
            <a
              key={`${it.kind}:${it.id}`} class="side-item" href={`#${docPath({ kind: it.kind, id: it.id })}`}
              onClick={(e) => { e.preventDefault(); openDoc({ kind: it.kind, id: it.id }); }}
            >
              <span class="side-icon" aria-hidden="true">{ICON[it.kind]}</span>
              <span class="side-label">{it.title}</span>
              {it.archived && <span class="muted side-archived">archived</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible Pinned and Recents lists from the `nav` store signal. Rows open through `openDoc`. */
export function SidebarLists() {
  const { pinned, recents } = nav.value;
  return (
    <>
      <Group title="Pinned" open={pinnedOpen} storeKey={KEY_PINNED} items={pinned} empty="Nothing pinned." />
      <Group title="Recents" open={recentsOpen} storeKey={KEY_RECENTS} items={recents} empty="Nothing opened yet." />
    </>
  );
}
