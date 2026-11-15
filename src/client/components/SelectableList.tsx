import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useKeys } from '../lib/keys.ts';
import type { KeyHandler } from '../lib/keys.ts';

export interface SelectableListProps<T> {
  items: T[];
  render: (item: T, selected: boolean) => ComponentChildren;
  onOpen?: (item: T) => void;
  /** Extra per-item bindings (binding syntax of useKeys), e.g. { x: toggle, 'd d': remove }. */
  keys?: Record<string, (item: T) => void>;
  empty?: string;
  /** Set false on all but the focused list when a view shows several. Default true. */
  enabled?: boolean;
  onSelect?: (item: T) => void;
}

function idOf(item: unknown): string | number | undefined {
  const id = typeof item === 'object' && item !== null ? (item as { id?: unknown }).id : undefined;
  return typeof id === 'number' || typeof id === 'string' ? id : undefined;
}

/** Owns j/k, arrows, g g, G and Enter. Rows are clickable/tappable. Items render as text. */
export function SelectableList<T>(props: SelectableListProps<T>) {
  const { items, onOpen, keys, enabled = true } = props;
  const [index, setIndex] = useState(0);
  const [selId, setSelId] = useState<string | number | undefined>(undefined);
  const n = items.length;
  // Items with an `id` keep their selection when the list reorders or changes.
  const byId = selId === undefined ? -1 : items.findIndex((it) => idOf(it) === selId);
  const sel = n === 0 ? -1 : byId >= 0 ? byId : Math.min(index, n - 1);
  const box = useRef<HTMLDivElement>(null);

  const select = (i: number) => { setIndex(i); setSelId(idOf(items[i])); };
  const move = (d: number) => { if (n > 0) select(Math.min(Math.max(sel + d, 0), n - 1)); };
  const current = (): T | undefined => (sel >= 0 ? items[sel] : undefined);

  const bindings: Record<string, KeyHandler> = {
    j: () => move(1), down: () => move(1),
    k: () => move(-1), up: () => move(-1),
    'g g': () => select(0),
    'shift+g': () => select(Math.max(n - 1, 0)),
    enter: () => { const it = current(); if (it !== undefined) onOpen?.(it); },
  };
  for (const [spec, fn] of Object.entries(keys ?? {})) {
    bindings[spec] = () => { const it = current(); if (it !== undefined) fn(it); };
  }
  useKeys(bindings, {
    scope: 'list', enabled,
    descriptions: { j: 'move down', k: 'move up', 'g g': 'top', 'shift+g': 'bottom', enter: 'open' },
  });

  const selectedItem = sel >= 0 ? items[sel] : undefined;
  useEffect(() => {
    if (selectedItem !== undefined) props.onSelect?.(selectedItem);
    box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [sel, selectedItem]);

  if (n === 0) return <div class="empty">{props.empty ?? 'Nothing here.'}</div>;
  return (
    <div class="list" role="listbox" ref={box}>
      {items.map((item, i) => (
        <div
          key={idOf(item) ?? i}
          class={`row${i === sel ? ' selected' : ''}`}
          role="option"
          aria-selected={i === sel}
          onClick={() => { select(i); onOpen?.(item); }}
        >
          <span class="row-marker" aria-hidden="true">{i === sel ? '>' : ' '}</span>
          <span class="row-body">{props.render(item, i === sel)}</span>
        </div>
      ))}
    </div>
  );
}
