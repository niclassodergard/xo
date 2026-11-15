import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Where focus was before the first overlay opened. An overlay that opens from another overlay (palette -> picker)
// returns to this, not to the dialog it was opened from, which is gone by then.
let baseFocus: HTMLElement | null = null;

/** Modal dialog shell: backdrop, role=dialog + aria-modal, label, and a Tab focus trap. */
export function Overlay(props: { label: string; wide?: boolean; onBackdrop?: () => void; children?: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  // Read during the first render, before any child moves focus into the dialog.
  const [opener] = useState<HTMLElement | null>(() => {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    // Opened from inside another dialog: keep that one's origin. Otherwise this is a fresh origin (maybe none).
    if (!(a instanceof HTMLElement && a.closest('[role=dialog]'))) baseFocus = a instanceof HTMLElement && a !== document.body ? a : null;
    return a instanceof HTMLElement && a !== document.body ? a : null;
  });

  // Make sure focus is inside the dialog before the first paint (children may focus a specific input).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || el.contains(document.activeElement)) return;
    // No focusable child (Help): focus the box itself, so focus never stays in a field behind the dialog.
    (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
  }, []);

  // On close, give focus back so stray typing is not run as commands on the view behind. Only when nobody
  // else took it (focus is on nothing, or still inside this dialog) and the element is still there.
  useLayoutEffect(() => () => {
    const a = document.activeElement;
    const free = a === null || a === document.body || !!box.current?.contains(a);
    // Stacked dialogs: go back into the dialog that opened this one if it is still there, else to the origin.
    const returnTo = opener?.isConnected && opener.closest('[role=dialog]') ? opener : baseFocus;
    if (free && returnTo?.isConnected) returnTo.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) { e.preventDefault(); return; }
    const first = items[0]!, last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !box.current.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || !box.current.contains(active))) { e.preventDefault(); first.focus(); }
  };

  return (
    <div class="overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onBackdrop?.(); }}>
      <div class={`dialog${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1} ref={box} onKeyDown={onKeyDown}>
        {props.children}
      </div>
    </div>
  );
}
