import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Id } from '../../shared/types.ts';
import { composing, modalOpen, useKeys } from '../lib/keys.ts';
import { oneLine } from '../lib/format.ts';
import { stepAction, stepRow } from '../lib/row-actions.ts';
import type { RowAction } from '../lib/row-actions.ts';
import { askConfirm, clearDraft, drafts, errorText, flash, setDraft } from '../lib/store.ts';
import { Chip } from './Chip.tsx';

/**
 * The add field. `draftId` is REQUIRED with `onAdd` (the type enforces it, and a dev build throws): it keys the
 * typed text in the store's `drafts` so the text survives a 401 remount, and it must include the owning entity
 * (e.g. 'person:12:agenda', 'project:3:actions', 'actions:none:add'), otherwise text typed for Anna would
 * appear in Bob's list.
 */
export type ListAdd =
  | {
    /** Adds an item from the add field. Must reject when the request fails: the typed text is then kept. */
    onAdd: (text: string) => Promise<unknown>;
    draftId: string;
    addPlaceholder?: string;
  }
  | { onAdd?: undefined; draftId?: undefined; addPlaceholder?: undefined };

export type ListProps<T extends { id: Id }> = {
  items: T[];
  /** Accessible name of the list. */
  label: string;
  render: (item: T) => ComponentChildren;
  actions: (item: T) => RowAction[];
  empty?: string;
  /** Key scope: 'panel' (default; fires while focus is in the panel) or 'modal' (a list inside a dialog). */
  scope?: 'panel' | 'modal';
} & ListAdd;

/** Key of the add-field text in `drafts`. */
export function addDraftKey(draftId: string): string { return `list-add:${draftId}`; }

let listCounter = 0;

/**
 * The one list pattern: Up/Down pick a row, Left/Right pick one of its action chips, Enter runs the
 * highlighted chip (default: the first action). The highlight is visual plus a live-region announcement;
 * real focus stays on the list container. A `danger` action always asks first. Handlers act on the
 * highlighted row only and re-check that it still exists. Chips are real buttons too (click, touch, Tab).
 */
export function List<T extends { id: Id }>(props: ListProps<T>) {
  const uid = useRef(`list-${++listCounter}`).current;
  const [selId, setSelState] = useState<Id | null>(null);
  const [chipId, setChipState] = useState<string | null>(null);
  // Mirrors of the highlight, updated synchronously: two quick key presses must both see the first one's result,
  // even before the component has re-rendered.
  const selRef = useRef<Id | null>(null);
  const chipRef = useRef<string | null>(null);
  const setSelId = (v: Id | null) => { selRef.current = v; setSelState(v); };
  const setChipId = (v: string | null) => { chipRef.current = v; setChipState(v); };
  const [focused, setFocused] = useState(false);
  const [announce, setAnnounce] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const addEl = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const itemsRef = useRef(props.items);
  itemsRef.current = props.items;
  const propsRef = useRef(props);
  propsRef.current = props;

  if (import.meta.env.DEV && props.onAdd && !(props.draftId && props.draftId.includes(':'))) {
    throw new Error(`List "${props.label}": onAdd needs a draftId that includes the owning entity, e.g. 'person:12:agenda'`);
  }
  const draftKey = addDraftKey(props.draftId ?? props.label);
  const addText = drafts.value[draftKey] ?? '';

  const idx = selId === null ? -1 : props.items.findIndex((i) => i.id === selId);
  const rowDomId = (id: Id) => `${uid}-row-${id}`;

  const select = (i: number) => {
    const it = itemsRef.current[i];
    if (it) { setSelId(it.id); setChipId(null); }
  };

  const invoke = (item: T, a: RowAction) => {
    const go = () => {
      // The row may have gone while the confirm was open.
      if (!itemsRef.current.some((i) => i.id === item.id)) return;
      void Promise.resolve().then(() => a.run()).catch((e: unknown) => flash(errorText(e), 'error'));
    };
    if (a.danger) askConfirm(`${a.label}: ${oneLine(rowText(item.id), 60) || 'this item'}?`, go);
    else go();
  };
  const rowText = (id: Id) => document.getElementById(rowDomId(id))?.querySelector('.row-body')?.textContent ?? '';

  const runHighlighted = () => {
    const item = itemsRef.current.find((i) => i.id === selRef.current);
    if (!item) return;
    const acts = propsRef.current.actions(item);
    const a = chipRef.current === null ? acts[0] : acts.find((x) => x.id === chipRef.current) ?? acts[0];
    if (a) invoke(item, a);
  };

  const focusAdd = (): boolean => { addEl.current?.focus(); return !!addEl.current; };

  const curIdx = () => itemsRef.current.findIndex((i) => i.id === selRef.current);
  const stepChip = (dir: 'left' | 'right') => {
    const item = itemsRef.current[curIdx()];
    if (item) setChipId(stepAction(propsRef.current.actions(item).map((a) => a.id), chipRef.current, dir));
  };
  useKeys({
    up: () => select(stepRow(itemsRef.current.length, curIdx(), 'up')),
    down: () => {
      const i = curIdx();
      if (i >= itemsRef.current.length - 1 && propsRef.current.onAdd && focusAdd()) return;
      select(stepRow(itemsRef.current.length, i, 'down'));
    },
    left: () => stepChip('left'),
    right: () => stepChip('right'),
    enter: runHighlighted,
  }, { scope: props.scope ?? 'panel', enabled: focused });

  // A deleted row hands the highlight to its neighbour (the row that took its place, else the new last row).
  const lastIdx = useRef(-1);
  if (idx >= 0) lastIdx.current = idx;
  // Layout effect: no key press can run between the row going away and the highlight moving on.
  useLayoutEffect(() => {
    if (selRef.current === null || props.items.some((i) => i.id === selRef.current)) return;
    const next = props.items[Math.min(Math.max(lastIdx.current, 0), props.items.length - 1)];
    setSelId(next ? next.id : null);
    setChipId(null);
  }, [props.items]);

  // Visual highlight is announced; the row stays in view.
  useEffect(() => {
    if (selId === null) { setAnnounce(''); return; }
    const row = document.getElementById(rowDomId(selId));
    if (!row) { setAnnounce(''); return; }
    row.scrollIntoView?.({ block: 'nearest' });
    const chip = chipId === null ? '' : propsRef.current.actions(itemsRef.current.find((i) => i.id === selId)!).find((a) => a.id === chipId)?.label;
    setAnnounce(`${oneLine(row.querySelector('.row-body')?.textContent ?? '', 120)}${chip ? `, ${chip}` : ''}`);
  }, [selId, chipId]);

  const onFocus = () => {
    setFocused(true);
    if (idx < 0 && itemsRef.current.length > 0) select(0);
  };

  const submitAdd = async () => {
    const raw = addEl.current?.value ?? '';
    const text = raw.trim();
    if (!text || adding.current || !propsRef.current.onAdd) return;
    adding.current = true;
    try {
      await propsRef.current.onAdd(text);
      clearDraft(draftKey, raw); // only if the user has not typed something newer meanwhile
    } catch { /* the creator reports the error; the text stays for another try */ }
    finally { adding.current = false; }
  };

  const onAddKey = (e: KeyboardEvent) => {
    if (composing(e) || modalOpen()) return;
    if (e.key === 'Enter') { e.preventDefault(); if (!e.repeat) void submitAdd(); }
    else if (e.key === 'ArrowUp' && (e.currentTarget as HTMLInputElement).value === '') {
      e.preventDefault();
      box.current?.focus();
      if (itemsRef.current.length > 0) select(itemsRef.current.length - 1);
    }
  };

  return (
    <div class="list-wrap">
      <div
        class="list" role="listbox" tabIndex={0} ref={box} aria-label={props.label}
        aria-activedescendant={idx >= 0 ? rowDomId(props.items[idx]!.id) : undefined}
        onFocus={onFocus} onBlur={() => setFocused(false)}
      >
        {props.items.map((item, i) => {
          const acts = props.actions(item);
          const selected = i === idx;
          return (
            <div
              key={item.id} id={rowDomId(item.id)} role="option" aria-selected={selected}
              class={`row${selected ? ' selected' : ''}`}
              onClick={() => { setSelId(item.id); setChipId(null); box.current?.focus(); if (acts[0]) invoke(item, acts[0]); }}
            >
              <div class="row-body">{props.render(item)}</div>
              {acts.length > 0 && (
                <div class="row-chips" role="group" aria-label="Actions">
                  {acts.map((a) => (
                    <Chip
                      key={a.id} label={a.label} danger={a.danger} highlighted={selected && chipId === a.id}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => { setSelId(item.id); setChipId(a.id); invoke(item, a); }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {props.items.length === 0 && <div class="empty">{props.empty ?? 'Nothing here.'}</div>}
      <div class="sr-only" role="status" aria-live="polite">{announce}</div>
      {props.onAdd && (
        <div class="list-add">
          <input
            ref={addEl} class="input" type="text" value={addText} spellcheck={false}
            placeholder={props.addPlaceholder ?? 'Add…'} aria-label={props.addPlaceholder ?? `Add to ${props.label}`}
            onInput={(e) => setDraft(draftKey, (e.target as HTMLInputElement).value)}
            onKeyDown={onAddKey}
          />
        </div>
      )}
    </div>
  );
}
