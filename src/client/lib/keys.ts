import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import { useLayoutEffect, useRef } from 'preact/hooks';

// Keyboard engine. The matching logic (tokens, sequences, layers, precedence) is DOM-free so it
// can be unit-tested in node; only installKeyListeners() and useKeys() touch the browser/Preact.

export type Mode = 'normal' | 'insert' | 'command';
export const mode: Signal<Mode> = signal<Mode>('normal');

/** The only keys that still work while typing (INSERT) or in the palette (COMMAND). */
export const TYPING_ALLOWED: ReadonlySet<string> = new Set(['esc', 'ctrl+k', 'alt+space']);
export const SEQUENCE_TIMEOUT_MS = 1000;

// ---- tokens -------------------------------------------------------------------------------

export interface KeyLike {
  key: string; code?: string;
  ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; metaKey?: boolean;
  isComposing?: boolean; keyCode?: number;
}

/** IME composition (Safari reports keyCode 229 with isComposing already false on the final key). */
export function composing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

const NAMED: Record<string, string> = {
  Escape: 'esc', Enter: 'enter', Tab: 'tab', ' ': 'space', ' ': 'space',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Backspace: 'backspace', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
};
const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Dead', 'Unidentified', 'Process']);
const LETTER = /^\p{L}$/u;

function build(ctrl: boolean, alt: boolean, shift: boolean, key: string): string {
  return [ctrl ? 'ctrl' : '', alt ? 'alt' : '', shift ? 'shift' : '', key].filter(Boolean).join('+');
}

/** Canonical token for a key event, or null for modifier-only presses. Ctrl and Cmd are the same. */
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
const MODIFIER_ALIASES: Record<string, 'ctrl' | 'alt' | 'shift'> = {
  ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', meta: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift',
};

function normalizeStep(step: string): string {
  if (step === '+') return '+';
  // A literal uppercase letter means shift+letter ('G').
  if (step.length === 1 && LETTER.test(step) && step !== step.toLowerCase()) return `shift+${step.toLowerCase()}`;
  const parts = step.split('+');
  const rawKey = parts.pop() ?? '';
  let ctrl = false, alt = false, shift = false;
  for (const p of parts) {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in key binding "${step}"`);
    if (m === 'ctrl') ctrl = true; else if (m === 'alt') alt = true; else shift = true;
  }
  const lower = rawKey.toLowerCase();
  const key = KEY_ALIASES[lower] ?? lower;
  if (!key) throw new Error(`Empty key in binding "${step}"`);
  return build(ctrl, alt, shift, key);
}

/** 'g c' -> ['g','c']; 'shift+g' / 'G' -> ['shift+g']; 'ctrl+k' -> ['ctrl+k']. */
export function parseSpec(spec: string): string[] {
  const steps = spec.trim().split(/\s+/).filter(Boolean);
  if (steps.length === 0) throw new Error('Empty key binding');
  return steps.map(normalizeStep);
}

// ---- engine -------------------------------------------------------------------------------

export type KeyHandler = (e: KeyboardEvent) => void;
/**
 * Precedence: modal > view > list > global. While any modal layer exists, lower layers do not
 * match at all, except the always-on keys below (only when bound in the global layer).
 */
export type Scope = 'modal' | 'view' | 'list' | 'global';
const PRIORITY: Record<Scope, number> = { modal: 3, view: 2, list: 1, global: 0 };
export const ALWAYS_ON: ReadonlySet<string> = new Set(['esc', 'ctrl+k']);

export interface LayerBinding { spec: string; steps: string[]; run: KeyHandler; description?: string }
export interface LayerInput {
  scope: Scope; modes: Mode[];
  bindings: { spec: string; run: KeyHandler; description?: string }[];
}
export interface BindingInfo { spec: string; description: string; scope: Scope }

interface Layer { scope: Scope; modes: Mode[]; bindings: LayerBinding[]; order: number }

export interface KeyEngine {
  addLayer(input: LayerInput): () => void;
  /** Feed one key. Returns true if the key was consumed (caller should preventDefault). */
  handle(ev: KeyLike, currentMode: Mode, domEvent?: KeyboardEvent): boolean;
  reset(): void;
  /** True while any modal layer (overlay, voice recording) exists, whatever the mode. */
  modalOpen(): boolean;
  listBindings(): BindingInfo[];
}

export function createKeyEngine(
  now: () => number = () => Date.now(),
  onPending?: (seq: string[] | null) => void,
): KeyEngine {
  const layers = new Set<Layer>();
  let counter = 0;
  let pending: { seq: string[]; at: number } | null = null;
  function setPending(p: { seq: string[]; at: number } | null) {
    pending = p;
    onPending?.(p ? p.seq : null);
  }

  function ordered(m: Mode): Layer[] {
    return [...layers]
      .filter((l) => l.modes.includes(m))
      .sort((a, b) => PRIORITY[b.scope] - PRIORITY[a.scope] || b.order - a.order);
  }

  /** Highest-priority layer with an exact match wins; otherwise any prefix match means "wait". */
  function match(seq: string[], m: Mode): { exact: LayerBinding | null; prefix: boolean } {
    let prefix = false;
    const modalOpen = [...layers].some((l) => l.scope === 'modal');
    for (const layer of ordered(m)) {
      let layerPrefix = false;
      for (const b of layer.bindings) {
        if (modalOpen && layer.scope !== 'modal') {
          // Only the global layer's Esc / Ctrl-K pass a modal; a view's own Esc must not.
          const alwaysOn = layer.scope === 'global' && b.steps.length === 1 && ALWAYS_ON.has(b.steps[0]!);
          if (!alwaysOn) continue;
        }
        if (b.steps.length === seq.length && b.steps.every((s, i) => s === seq[i])) return { exact: b, prefix: false };
        if (b.steps.length > seq.length && seq.every((s, i) => s === b.steps[i])) layerPrefix = true;
      }
      if (layerPrefix) { prefix = true; break; }
    }
    return { exact: null, prefix };
  }

  return {
    addLayer(input) {
      const layer: Layer = {
        scope: input.scope, modes: input.modes, order: counter++,
        bindings: input.bindings.map((b) => ({ ...b, steps: parseSpec(b.spec) })),
      };
      layers.add(layer);
      return () => { layers.delete(layer); };
    },
    handle(ev, currentMode, domEvent) {
      if (composing(ev)) return false;
      const token = eventToken(ev);
      if (token === null) return false;
      if (currentMode !== 'normal' && !TYPING_ALLOWED.has(token)) { setPending(null); return false; }
      const t = now();
      let seq = pending && t - pending.at <= SEQUENCE_TIMEOUT_MS ? [...pending.seq, token] : [token];
      setPending(null);
      let res = match(seq, currentMode);
      if (!res.exact && !res.prefix && seq.length > 1) {
        seq = [token];
        res = match(seq, currentMode);
      }
      if (res.exact) {
        if (domEvent) res.exact.run(domEvent);
        else res.exact.run(undefined as unknown as KeyboardEvent);
        return true;
      }
      if (res.prefix) { setPending({ seq, at: t }); return true; }
      return false;
    },
    reset() { setPending(null); },
    modalOpen() { return [...layers].some((l) => l.scope === 'modal'); },
    listBindings() {
      const out: BindingInfo[] = [];
      const seen = new Set<string>();
      for (const layer of [...layers].sort((a, b) => PRIORITY[b.scope] - PRIORITY[a.scope] || a.order - b.order)) {
        for (const b of layer.bindings) {
          const id = `${layer.scope}:${b.spec}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ spec: b.spec, description: b.description ?? '', scope: layer.scope });
        }
      }
      return out;
    },
  };
}

/** The prefix typed so far (e.g. 'g'), shown in the status line; cleared when the sequence times out. */
export const pendingKeys: Signal<string> = signal('');
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
export const engine: KeyEngine = createKeyEngine(undefined, (seq) => {
  clearTimeout(pendingTimer);
  pendingKeys.value = seq ? seq.join(' ') : '';
  if (seq) pendingTimer = setTimeout(() => { pendingKeys.value = ''; }, SEQUENCE_TIMEOUT_MS);
});

/** True while a modal layer exists. Element-level key handlers (the chat input) use it to stand down behind overlays. */
export function modalOpen(): boolean { return engine.modalOpen(); }

// Key-up listeners (hold-to-talk). The engine only sees key-down: a binding runs on the first
// down (check `e.repeat` to ignore auto-repeat) and the feature subscribes here for the release.
const keyUpListeners = new Set<(e: KeyboardEvent) => void>();
export function onKeyUp(fn: (e: KeyboardEvent) => void): () => void {
  keyUpListeners.add(fn);
  return () => { keyUpListeners.delete(fn); };
}

// ---- Preact hook --------------------------------------------------------------------------

export interface UseKeysOptions {
  modes?: Mode[]; enabled?: boolean;
  /** Help-overlay text per binding spec. */
  descriptions?: Record<string, string>;
  /** Precedence: view > list > global. Views use the default. */
  scope?: Scope;
}

/**
 * Register key bindings while the component is mounted. Binding syntax: 'j', 'shift+g', 'g c'
 * (sequence, 1 s timeout), 'ctrl+k', 'enter', 'esc', 'space'. Handlers always see the latest render.
 */
export function useKeys(bindings: Record<string, KeyHandler>, opts: UseKeysOptions = {}): void {
  const ref = useRef(bindings);
  ref.current = bindings;
  const descRef = useRef(opts.descriptions);
  descRef.current = opts.descriptions;
  const enabled = opts.enabled ?? true;
  const modes = opts.modes ?? ['normal'];
  const scope = opts.scope ?? 'view';
  const specs = Object.keys(bindings);
  const signature = `${specs.join('|')}#${modes.join(',')}#${enabled}#${scope}`;
  // Layout effect: a layer (especially a modal one) must exist before the next keystroke, and be gone as
  // soon as its component unmounts; useEffect runs after paint and leaves a window with the wrong layers.
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    return engine.addLayer({
      scope, modes,
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
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Install the window-level key and focus listeners once. Returns the uninstall function. */
export function installKeyListeners(win: Window = window): () => void {
  const doc = win.document;
  const reconcile = () => {
    if (mode.value === 'command') return;
    const typing = isTextEntry(doc.activeElement);
    if (typing && mode.value !== 'insert') mode.value = 'insert';
    else if (!typing && mode.value === 'insert') mode.value = 'normal';
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    reconcile();
    const token = eventToken(e);
    const t = e.target;
    // Let focused buttons/links keep Enter and Space (activation).
    if ((token === 'enter' || token === 'space') && t instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(t.tagName)) return;
    if (engine.handle(e, mode.value, e)) e.preventDefault();
  };
  const onFocus = () => reconcile();
  const onKeyUpEv = (e: KeyboardEvent) => { for (const fn of keyUpListeners) fn(e); };
  // After a mouse click, drop focus from buttons/links so Space/Enter keep reaching the key engine.
  const onClick = (e: MouseEvent) => {
    const t = e.target;
    if (e.detail > 0 && t instanceof HTMLElement && /^(BUTTON|A)$/.test(t.tagName)) t.blur();
  };
  win.addEventListener('keyup', onKeyUpEv, true);
  win.addEventListener('click', onClick);
  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('focusin', onFocus, true);
  const onFocusOut = () => queueMicrotask(reconcile);
  win.addEventListener('focusout', onFocusOut, true);
  return () => {
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUpEv, true);
    win.removeEventListener('click', onClick);
    win.removeEventListener('focusin', onFocus, true);
    win.removeEventListener('focusout', onFocusOut, true);
    engine.reset();
  };
}
