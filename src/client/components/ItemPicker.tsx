import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Id } from '../../shared/types.ts';
import { composing, useKeys } from '../lib/keys.ts';
import { people, projects } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';

const fold = (s: string) => s.normalize('NFC').toLowerCase();

export interface PickItem { id: Id; label: string; extra: string[]; note?: string }

/** Items whose label or an extra string (alias) contains the query (Unicode case folding). Empty query: all. */
export function matchItems(query: string, all: PickItem[]): PickItem[] {
  const q = fold(query.trim());
  if (!q) return all;
  return all.filter((i) => fold(i.label).includes(q) || i.extra.some((a) => fold(a).includes(q)));
}

export type ItemPickerProps = { kind: 'person' | 'project'; onCancel: () => void } & (
  | { allowNone?: false; onPick: (id: Id) => void }
  | { allowNone: true; onPick: (id: Id | null) => void }
);

/**
 * Modal picker for a person or a project: type to filter, Up/Down to move the highlight, Enter to pick,
 * Esc to cancel. Renders its own Overlay. With `allowNone` a "None" row comes first and picks `null`.
 */
export function ItemPicker(props: ItemPickerProps) {
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all: PickItem[] = props.kind === 'person'
    ? people.value.filter((p) => p.archivedAt === null).map((p) => ({ id: p.id, label: p.name, extra: p.aliases }))
    : projects.value.map((p) => ({ id: p.id, label: p.title, extra: p.aliases, note: p.status === 'active' ? undefined : p.status.replace('_', ' ') }));
  const found = matchItems(query, all);
  const rows: { id: Id | null; item: PickItem | null }[] = [
    ...(props.allowNone ? [{ id: null, item: null }] : []),
    ...found.map((item) => ({ id: item.id as Id | null, item })),
  ];
  const sel = Math.min(idx, Math.max(rows.length - 1, 0));
  const noun = props.kind === 'person' ? 'person' : 'project';

  useLayoutEffect(() => { input.current?.focus(); }, []);
  useKeys({ esc: () => props.onCancel() }, { scope: 'modal' });

  const pick = (id: Id | null) => {
    if (id === null) { if (props.allowNone) props.onPick(null); } else (props.onPick as (id: Id) => void)(id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(sel + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(sel - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;
      const r = rows[sel];
      if (r) pick(r.id);
    }
  };
  const rowId = (r: { id: Id | null }) => `picker-${props.kind}-${r.id ?? 'none'}`;

  return (
    <Overlay label={`Pick ${noun}`} onBackdrop={props.onCancel}>
      <h2>{`Pick ${noun}`}</h2>
      <input
        ref={input} class="input" type="text" value={query} placeholder="Type to filter…" spellcheck={false}
        aria-label={`Filter ${noun === 'person' ? 'people' : 'projects'}`} role="combobox" aria-expanded="true"
        aria-controls="picker-list" aria-autocomplete="list"
        aria-activedescendant={rows[sel] ? rowId(rows[sel]!) : undefined}
        onInput={(e) => { setQuery((e.target as HTMLInputElement).value); setIdx(0); }}
        onKeyDown={onKeyDown}
      />
      <div class="results" role="listbox" id="picker-list" aria-label={noun === 'person' ? 'People' : 'Projects'}>
        {rows.length === 0 && <div class="empty">{`No matching ${noun === 'person' ? 'people' : 'projects'}.`}</div>}
        {rows.map((r, i) => (
          <div key={r.id ?? 'none'} id={rowId(r)} class={`row${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} onClick={() => pick(r.id)}>
            <span class="row-body">
              {r.item ? r.item.label : 'None'}
              {r.item?.note && <span class="muted">{`  (${r.item.note})`}</span>}
            </span>
          </div>
        ))}
      </div>
    </Overlay>
  );
}
