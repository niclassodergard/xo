import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { commandList, composing, filterCommands, useKeys } from '../lib/keys.ts';
import type { Command } from '../lib/keys.ts';
import { closeOverlay } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';
import { Pane } from './Pane.tsx';

const ALL = ['normal', 'insert', 'command'] as const;

/** Command palette: fuzzy filter, Up/Down (Ctrl-N/P), Enter. Esc and Ctrl-K close it. */
export function Palette() {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = filterCommands(query, commandList.value);
  const sel = Math.min(idx, Math.max(results.length - 1, 0));
  // Synchronous: the next keystroke must land in this input, not in a NORMAL-mode binding.
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useKeys({ esc: closeOverlay }, { scope: 'modal', modes: [...ALL] });

  const run = (cmd: Command) => {
    closeOverlay();
    cmd.run();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    const next = e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'j'));
    const prev = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (next) { e.preventDefault(); setIdx(Math.min(sel + 1, results.length - 1)); }
    else if (prev) { e.preventDefault(); setIdx(Math.max(sel - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const c = results[sel];
      if (c) run(c);
    }
  };
  return (
    <Overlay label="Command palette" onBackdrop={closeOverlay}>
      <Pane title="Command" focused>
        <div class="prompt-line">
          <span class="accent" aria-hidden="true">:</span>
          <input
            ref={input} class="textedit" type="text" value={query} spellcheck={false} placeholder="type a command…"
            aria-label="Command" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list"
            aria-activedescendant={results[sel] ? `palette-${results[sel]!.id}` : undefined}
            onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setIdx(0); }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div class="list" role="listbox" id="palette-list" aria-label="Commands">
          {results.length === 0 && <div class="empty">No matching commands.</div>}
          {results.map((c, i) => (
            <div key={c.id} id={`palette-${c.id}`} class={`row${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} onClick={() => run(c)}>
              <span class="row-marker" aria-hidden="true">{i === sel ? '>' : ' '}</span>
              <span class="row-body">{c.title}</span>
            </div>
          ))}
        </div>
      </Pane>
    </Overlay>
  );
}
