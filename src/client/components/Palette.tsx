import { Fragment } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { SearchHit, SearchResponse } from '../../shared/api.ts';
import { api } from '../lib/api.ts';
import { commandList, composing, filterCommands, registerCommand, useKeys } from '../lib/keys.ts';
import { isPinned, openDoc, pinTargetOf, togglePin } from '../lib/nav.ts';
import type { DocRef } from '../lib/nav.ts';
import {
  buildRows, createSearchTickets, groupStarts, GROUP_TITLE, localMatches, reselect, SEARCH_DEBOUNCE_MS, SEARCH_LIMIT, shouldSearch,
} from '../lib/palette-logic.ts';
import type { PaletteRow } from '../lib/palette-logic.ts';
import { route } from '../lib/router.ts';
import { closeOverlay, epoch, people, projects } from '../lib/store.ts';
import '../styles/nav.css';
import { Overlay } from './Overlay.tsx';

/**
 * "Search and commands" (Cmd-K): one input and three result groups in one list: commands, people and
 * projects by name (local), and server search hits (POST, debounced, never in the URL). Up/Down walk across
 * the groups, Enter runs a command or opens the document via `openDoc`. Esc and Cmd-K close it.
 */
export function Palette() {
  const [query, setQuery] = useState('');
  const [selKey, setSelKey] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'searching' | 'failed'>('idle');
  const [tickets] = useState(createSearchTickets);
  const input = useRef<HTMLInputElement>(null);

  // Synchronous: the first typed characters must land in this input.
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useKeys({ esc: closeOverlay }, { scope: 'modal' });

  // "Pin current" / "Unpin current" while a person or project is open (registered only while the palette is).
  useLayoutEffect(() => {
    const target = pinTargetOf(route.peek());
    if (!target) return undefined;
    const pinned = isPinned(target.kind, target.id);
    return registerCommand({
      id: 'pin.toggle', title: pinned ? 'Unpin current' : 'Pin current', keywords: ['pin', 'favourite', 'sidebar'],
      run: () => { void togglePin(target.kind, target.id); },
    });
  }, []);

  // Server search: debounced, and a response counts only while it is the newest and in the same session.
  useEffect(() => {
    if (!shouldSearch(query)) { tickets.cancel(); setStatus('idle'); return undefined; }
    const q = query.trim();
    const timer = setTimeout(() => {
      const e = epoch();
      const ticket = tickets.begin(e);
      setStatus('searching');
      api.post<SearchResponse>('/api/search', { q, limit: SEARCH_LIMIT }).then(
        (r) => { if (tickets.isCurrent(ticket, epoch())) { setHits(r.results); setStatus('idle'); } },
        () => { if (tickets.isCurrent(ticket, epoch())) { setHits([]); setStatus('failed'); } },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => { clearTimeout(timer); tickets.cancel(); };
  }, [query, tickets]);
  useEffect(() => () => tickets.cancel(), [tickets]);

  const commands = filterCommands(query, commandList.value);
  const names = localMatches(query, people.value, projects.value);
  const rows = buildRows(commands, names, hits);
  const sel = Math.min(reselect(selKey, rows), Math.max(rows.length - 1, 0));
  const starts = groupStarts(rows);
  const rowId = (r: PaletteRow) => `palette-${r.key.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  const run = (row: PaletteRow) => {
    closeOverlay();
    // After the palette unmounted: its modal key layer is still registered right now, and a command that opens
    // another overlay (Shortcuts, pickers, prompts) or a document would see it as "another overlay is open".
    if (row.group === 'commands') {
      const cmd = commandList.peek().find((c) => c.id === row.commandId);
      if (cmd) setTimeout(cmd.run, 0);
    } else {
      const ref: DocRef = row.ref;
      setTimeout(() => openDoc(ref), 0);
    }
  };
  const move = (to: number) => { const r = rows[Math.max(0, Math.min(to, rows.length - 1))]; if (r) setSelKey(r.key); };
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === 'Enter' && e.repeat) { e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(sel + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(sel - 1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[sel];
      if (r) run(r);
    }
  };
  return (
    <Overlay label="Search and commands" onBackdrop={closeOverlay}>
      <input
        ref={input} class="input" type="text" value={query} spellcheck={false} placeholder="Search or type a command…"
        aria-label="Search and commands" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
        aria-activedescendant={rows[sel] ? rowId(rows[sel]!) : undefined}
        onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setSelKey(null); setHits([]); }}
        onKeyDown={onKeyDown}
      />
      <div class="results" role="listbox" id="palette-list" aria-label="Results">
        {rows.length === 0 && <div class="empty">{status === 'searching' ? 'Searching…' : 'No matches.'}</div>}
        {rows.map((r, i) => (
          <Fragment key={r.key}>
            {starts.has(i) && <div class="group-title" role="presentation">{GROUP_TITLE[starts.get(i)!]}</div>}
            <div id={rowId(r)} class={`row${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} onClick={() => run(r)}>
              <span class="row-body">
                {r.title}
                {r.group !== 'commands' && r.sub && <span class="muted palette-sub">{`  ${r.sub}`}</span>}
              </span>
            </div>
          </Fragment>
        ))}
      </div>
      <div class="hint" role="status" aria-live="polite">
        {status === 'searching' && rows.length > 0 ? 'Searching…' : status === 'failed' ? 'Search failed.' : ''}
      </div>
    </Overlay>
  );
}
