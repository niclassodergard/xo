import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { focusTarget } from './focus.ts';

// Keyboard engine (v0.2): no modes, no key sequences. Matching is DOM-free (the caller passes a
// FocusContext) so it can be unit-tested in node; only installKeyListeners() and useKeys() touch the
// browser and Preact. Rules (plan 4.8):
//  1. While a `modal` layer exists, only modal bindings match, except `esc` and `mod+k` in the global layer.
//  2. While focus is in a text entry, only bindings with mod or alt, and `esc`, fire.
//  3. `panel` / `stream` bindings fire only while focus is inside [data-region="panel" | "stream"].
//  4. A focused button, link or checkbox keeps native Enter and Space.
//  5. Type-to-composer: a printable key with no text entry focused and no modal open focuses the composer.

// ---- tokens -------------------------------------------------------------------------------

export interface KeyLike {
  key: string; code?: string;
  ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean;
  isComposing?: boolean; keyCode?: number; repeat?: boolean;
}

/** IME composition (Safari reports keyCode 229 with isComposing already false on the final key). */
export function composing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

const NAMED: Record<string, string> = {
  Escape: 'esc', Enter: 'enter', Tab: 'tab', ' ': 'space',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};
const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Unidentified', 'Process']);
const LETTER = /^\p{L}$/u;

function build(mod: boolean, alt: boolean, shift: boolean, key: string): string {
  return [mod ? 'mod' : '', alt ? 'alt' : '', shift ? 'shift' : '', key].filter(Boolean).join('+');
}

/** Canonical token for a key event, or null for modifier-only presses. Ctrl and Cmd are the same (`mod`). */
export function eventToken(ev: KeyLike): string | null {
  if (MODIFIER_ONLY.has(ev.key)) return null;
  const key = ev.code === 'Space' ? 'space' : (NAMED[ev.key] ?? ev.key.toLowerCase());
  // Shift is only meaningful for letters and named keys; for '?' or ':' the character already encodes it.
  const shift = !!ev.shiftKey && (key.length > 1 || LETTER.test(key));
  return build(!!(ev.ctrlKey || ev.metaKey), !!ev.altKey, shift, key);
}

const KEY_ALIASES: Record<string, string> = {
  escape: 'esc', return: 'enter', ' ': 'space', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};
const MODIFIER_ALIASES: Record<string, 'mod' | 'alt' | 'shift'> = {
  mod: 'mod', ctrl: 'mod', control: 'mod', cmd: 'mod', meta: 'mod', alt: 'alt', option: 'alt', shift: 'shift',
};

/** 'mod+k' -> 'mod+k'; 'ctrl+K' -> 'mod+k'; 'Escape' -> 'esc'; 'G' -> 'shift+g'. One key, no sequences. */
export function parseSpec(spec: string): string {
  const step = spec.trim();
  if (step === '') throw new Error('Empty key binding');
  if (/\s/.test(step)) throw new Error(`Key sequences are not supported: "${spec}"`);
  if (step === '+') return '+';
  if (step.length === 1 && LETTER.test(step) && step !== step.toLowerCase()) return `shift+${step.toLowerCase()}`;
  const parts = step.split('+');
  const rawKey = parts.pop() ?? '';
  let mod = false, alt = false, shift = false;
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in key binding "${spec}"`);
    if (m === 'mod') mod = true; else if (m === 'alt') alt = true; else shift = true;
  }
  const lower = rawKey.toLowerCase();
  const key = KEY_ALIASES[lower] ?? lower;
  if (!key) throw new Error(`Empty key in binding "${spec}"`);
  return build(mod, alt, shift, key);
}

function hasModOrAlt(token: string): boolean {
  const parts = token.split('+');
  parts.pop();
  return parts.includes('mod') || parts.includes('alt');
}

// ---- engine -------------------------------------------------------------------------------

export type KeyHandler = (e: KeyboardEvent) => void;
/** Precedence: modal > panel / stream (disjoint regions) > global. */
export type Scope = 'modal' | 'panel' | 'stream' | 'global';
const PRIORITY: Record<Scope, number> = { modal: 3, panel: 2, stream: 2, global: 0 };
/** The only keys that pass a modal layer, and only when bound in the global layer. */
export const ALWAYS_ON: ReadonlySet<string> = new Set(['esc', 'mod+k']);

/** What the engine needs to know about focus; computed from the DOM by installKeyListeners. */
export interface FocusContext {
  /** A text field, textarea, select or contenteditable has focus. */
  textEntry: boolean;
  /** `data-region` of the closest ancestor of the focused element (e.g. 'panel', 'stream'), or null. */
  region: string | null;
  /** The key's target is a button, link, summary or checkbox: it keeps native Enter and Space. */
  nativeActivation: boolean;
}
export const NO_FOCUS: FocusContext = { textEntry: false, region: null, nativeActivation: false };

interface LayerBinding { spec: string; token: string; run: KeyHandler; description?: string }
export interface LayerInput { scope: Scope; bindings: { spec: string; run: KeyHandler; description?: string }[] }
interface Layer { scope: Scope; bindings: LayerBinding[]; order: number }

export interface KeyEngine {
  addLayer(input: LayerInput): () => void;
  /** Feed one key. Returns true if the key was consumed (the caller should preventDefault). */
  handle(ev: KeyLike, ctx: FocusContext, domEvent?: KeyboardEvent): boolean;
  /** True while any modal layer (overlay, drawer, voice recording) exists. */
  modalOpen(): boolean;
}

export function createKeyEngine(): KeyEngine {
  const layers = new Set<Layer>();
  let counter = 0;
  const isModalOpen = (): boolean => { for (const l of layers) if (l.scope === 'modal') return true; return false; };

  return {
    addLayer(input) {
      const layer: Layer = {
        scope: input.scope, order: counter++,
        bindings: input.bindings.map((b) => ({ ...b, token: parseSpec(b.spec) })),
      };
      layers.add(layer);
      return () => { layers.delete(layer); };
    },
    handle(ev, ctx, domEvent) {
      if (composing(ev)) return false;
      const token = eventToken(ev);
      if (token === null) return false;
      // A held Enter (auto-repeat) never runs anything: one press, one action.
      if (token === 'enter' && ev.repeat) return false;
      // Rule 4: focused buttons/links/checkboxes keep native Enter and Space.
      if (ctx.nativeActivation && (token === 'enter' || token === 'space')) return false;
      // Rule 2: a text field owns plain keys; only mod/alt combinations and Esc reach bindings.
      if (ctx.textEntry && token !== 'esc' && !hasModOrAlt(token)) return false;
      const modal = isModalOpen();
      const ordered = [...layers].sort((a, b) => PRIORITY[b.scope] - PRIORITY[a.scope] || b.order - a.order);
      for (const layer of ordered) {
        if (modal && layer.scope !== 'modal' && !(layer.scope === 'global' && ALWAYS_ON.has(token))) continue; // rule 1
        if (layer.scope === 'panel' && ctx.region !== 'panel') continue; // rule 3
        if (layer.scope === 'stream' && ctx.region !== 'stream') continue;
        const b = layer.bindings.find((x) => x.token === token);
        if (b) {
          b.run(domEvent ?? (undefined as unknown as KeyboardEvent));
          return true;
        }
      }
      return false;
    },
    modalOpen: isModalOpen,
  };
}

export const engine: KeyEngine = createKeyEngine();

/** True while a modal layer exists. Element-level key handlers (composer, add fields) stand down behind overlays. */
export function modalOpen(): boolean { return engine.modalOpen(); }

/** Count of real key presses so far; see keystrokeMark(). */
let keystrokes = 0;
/**
 * Take this before an await, and compare after it with `typedSince(mark)`: an async result must not move focus
 * when the user typed meanwhile (their letters would land in the wrong place).
 */
export function keystrokeMark(): number { return keystrokes; }
export function typedSince(mark: number): boolean { return keystrokes !== mark; }

/**
 * Rule 5. A printable key (no mod; Option alone counts, for `@` on a Swedish Mac; not Space or Enter) pressed with no text entry focused and no modal
 * open belongs to the composer. Called only after no binding consumed the key.
 */
export function shouldTypeToComposer(ev: KeyLike, ctx: FocusContext, modalIsOpen: boolean): boolean {
  if (modalIsOpen || ctx.textEntry || composing(ev)) return false;
  if (ev.ctrlKey || ev.metaKey) return false;
  return typeof ev.key === 'string' && [...ev.key].length === 1 && ev.key !== ' ';
}

// Key-up listeners (hold-to-talk). The engine only sees key-down: a binding runs on the first
// down (check `e.repeat` to ignore auto-repeat) and the feature subscribes here for the release.
const keyUpListeners = new Set<(e: KeyboardEvent) => void>();
export function onKeyUp(fn: (e: KeyboardEvent) => void): () => void {
  keyUpListeners.add(fn);
  return () => { keyUpListeners.delete(fn); };
}

// ---- Preact hook --------------------------------------------------------------------------

export interface UseKeysOptions {
  enabled?: boolean;
  /** Help text per binding spec (documentation; the Help overlay itself reads lib/keymap.ts). */
  descriptions?: Record<string, string>;
  /** Default 'global'. */
  scope?: Scope;
}

/**
 * Register key bindings while the component is mounted. Binding syntax: 'mod+k', 'alt+space', 'esc',
 * 'enter', 'up', 'down', 'left', 'right', 'space', 'shift+…'. Handlers always see the latest render.
 * Registered in a layout effect: a layer (especially a modal one) must exist before the next keystroke
 * and be gone as soon as its component unmounts.
 */
export function useKeys(bindings: Record<string, KeyHandler>, opts: UseKeysOptions = {}): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  const descRef = useRef(opts.descriptions);
  descRef.current = opts.descriptions;
  const enabled = opts.enabled ?? true;
  const scope = opts.scope ?? 'global';
  const specs = Object.keys(bindings);
  const signature = `${specs.join('|')}#${enabled}#${scope}`;
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return engine.addLayer({
      scope,
      bindings: specs.map((spec) => ({
        spec,
        run: (e) => ref.current[spec]?.(e),
        description: descRef.current?.[spec],
      })),
    });
  }, [signature]);
}

// ---- command registry (palette) -----------------------------------------------------------

export interface Command { id: string; title: string; run: () => void; keywords?: string[] }
export const commandList: Signal<Command[]> = signal<Command[]>([]);

/** Add a palette entry (same id replaces). Returns the unregister function. */
export function registerCommand(cmd: Command): () => void {
  commandList.value = [...commandList.value.filter((c) => c.id !== cmd.id), cmd];
  return () => {
    if (commandList.value.includes(cmd)) commandList.value = commandList.value.filter((c) => c !== cmd);
  };
}

/** Subsequence match; null = no match, higher = better. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  let from = 0, score = t.includes(q) ? 10 : 0, last = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const at = t.indexOf(ch, from);
    if (at < 0) return null;
    score += 1;
    if (at === last + 1) score += 2;
    if (at === 0 || t[at - 1] === ' ') score += 3;
    last = at; from = at + 1;
  }
  return score - t.length * 0.01;
}

export function filterCommands(query: string, cmds: Command[]): Command[] {
  const scored: { cmd: Command; score: number; i: number }[] = [];
  cmds.forEach((cmd, i) => {
    const a = fuzzyScore(query, cmd.title);
    const k = cmd.keywords?.length ? fuzzyScore(query, cmd.keywords.join(' ')) : null;
    const best = Math.max(a ?? -Infinity, k === null ? -Infinity : k - 1);
    if (best > -Infinity) scored.push({ cmd, score: best, i });
  });
  scored.sort((x, y) => y.score - x.score || x.i - y.i);
  return scored.map((s) => s.cmd);
}

// ---- DOM glue -----------------------------------------------------------------------------

export function isTextEntry(el: Element | null): boolean {
  if (!el || typeof HTMLElement === 'undefined') return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

const NATIVE_TAGS = /^(BUTTON|A|SUMMARY)$/;

/** Focus facts for one key event. Tolerates the fake DOM objects of unit tests. */
export function focusContext(active: Element | null, target: EventTarget | null): FocusContext {
  const closest = active && typeof (active as Element).closest === 'function'
    ? (active as Element).closest('[data-region]') : null;
  const t = target as (HTMLElement & { type?: string }) | null;
  const tag = t && typeof t.tagName === 'string' ? t.tagName : '';
  const nativeActivation = NATIVE_TAGS.test(tag) || (tag === 'INPUT' && (t?.type === 'checkbox' || t?.type === 'radio'));
  return {
    textEntry: isTextEntry(active),
    region: closest ? closest.getAttribute('data-region') : null,
    nativeActivation,
  };
}

/** Install the window-level key listeners once. Returns the uninstall function. */
export function installKeyListeners(win: Window = window): () => void {
  const doc = win.document;
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (eventToken(e) !== null) keystrokes++;
    const ctx = focusContext(doc.activeElement, e.target);
    if (engine.handle(e, ctx, e)) { e.preventDefault(); return; }
    // Rule 5: no binding took it. Not prevented, so the character lands in the composer.
    if (shouldTypeToComposer(e, ctx, engine.modalOpen())) focusTarget('composer', { queue: false });
  };
  const onKeyUpEv = (e: KeyboardEvent) => { for (const fn of keyUpListeners) fn(e); };
  // After a mouse click, drop focus from buttons/links so Space keeps reaching push-to-talk.
  const onClick = (e: MouseEvent) => {
    const t = e.target;
    if (e.detail > 0 && t instanceof HTMLElement && /^(BUTTON|A)$/.test(t.tagName) && !t.closest('[role=dialog]')) t.blur();
  };
  win.addEventListener('keyup', onKeyUpEv, true);
  win.addEventListener('click', onClick);
  win.addEventListener('keydown', onKeyDown, true);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUpEv, true);
    win.removeEventListener('click', onClick);
  };
}
