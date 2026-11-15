import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Modal dialog shell: backdrop, role=dialog + aria-modal, label, and a Tab focus trap. */
export function Overlay(props: { label: string; wide?: boolean; onBackdrop?: () => void; children?: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);

  // Make sure focus is inside the dialog before the first paint (children may focus a specific input).
  useLayoutEffect(() => {
    const el = box.current;
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
      <div class={`dialog${props.wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.label} ref={box} onKeyDown={onKeyDown}>
        {props.children}
      </div>
    </div>
  );
}
