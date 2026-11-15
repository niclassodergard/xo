import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Person } from '../../shared/types.ts';
import { composing, useKeys } from '../lib/keys.ts';
import { people } from '../lib/store.ts';
import { Pane } from './Pane.tsx';

const fold = (s: string) => s.normalize('NFC').toLowerCase();

export function matchPeople(query: string, all: Person[]): Person[] {
  const q = fold(query.trim());
  if (!q) return all;
  return all.filter((p) => fold(p.name).includes(q) || p.aliases.some((a) => fold(a).includes(q)));
}

/** Type to filter, Up/Down (or Ctrl-N/P) to move, Enter to pick, Esc to cancel. Modal while mounted. */
export function PersonPicker(props: { onPick: (p: Person) => void; onCancel: () => void }) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const found = matchPeople(query, people.value.filter((p) => p.archivedAt === null));
  const sel = Math.min(idx, Math.max(found.length - 1, 0));

  useLayoutEffect(() => { input.current?.focus(); }, []);
  useKeys({ esc: () => props.onCancel() }, { scope: 'modal', modes: ['normal', 'insert', 'command'] });

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    const next = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n');
    const prev = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p');
    if (next) { e.preventDefault(); setIdx(Math.min(sel + 1, found.length - 1)); }
    else if (prev) { e.preventDefault(); setIdx(Math.max(sel - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const p = found[sel];
      if (p) props.onPick(p);
    }
  };

  return (
    <Pane title="Pick person" focused>
      <input
        ref={input} class="textedit" type="text" value={query} placeholder="type to filter…" spellcheck={false}
        aria-label="Filter people" role="combobox" aria-expanded="true" aria-controls="picker-list" aria-autocomplete="list"
        aria-activedescendant={found[sel] ? `picker-${found[sel]!.id}` : undefined}
        onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setIdx(0); }}
        onKeyDown={onKeyDown}
      />
      <div class="list" role="listbox" id="picker-list" aria-label="People">
        {found.length === 0 && <div class="empty">No matching people.</div>}
        {found.map((p, i) => (
          <div key={p.id} id={`picker-${p.id}`} class={`row${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} onClick={() => props.onPick(p)}>
            <span class="row-marker" aria-hidden="true">{i === sel ? '>' : ' '}</span>
            <span class="row-body">{p.name}{p.aliases.length > 0 && <span class="dim">{`  (${p.aliases.join(', ')})`}</span>}</span>
          </div>
        ))}
      </div>
    </Pane>
  );
}
