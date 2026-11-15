import { engine, useKeys } from '../lib/keys.ts';
import { closeOverlay } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';
import { Pane } from './Pane.tsx';

const NAMES: Record<string, string> = {
  esc: 'Esc', enter: 'Enter', tab: 'Tab', space: 'Space', up: '↑', down: '↓', left: '←', right: '→',
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift',
};

/** 'ctrl+k' -> 'Ctrl-K', 'shift+g' -> 'G', 'g c' -> 'g c', 'esc' -> 'Esc'. */
export function keyLabel(spec: string): string {
  return spec.split(' ').map((step) => {
    const parts = step.split('+');
    const key = parts.pop() ?? '';
    if (parts.length === 1 && parts[0] === 'shift' && key.length === 1) return key.toUpperCase();
    const k = NAMES[key] ?? (parts.length > 0 ? key.toUpperCase() : key);
    return [...parts.map((p) => NAMES[p] ?? p), k].join('-');
  }).join(' ');
}

/** Generated from the bindings registered right now (global, lists, and the current view). */
export function Help() {
  useKeys({ esc: closeOverlay, '?': closeOverlay }, { scope: 'modal', modes: ['normal', 'insert', 'command'] });
  // Registered bindings, minus the help overlay's own modal layer; one row per label.
  const infos = engine.listBindings().filter((b) => b.scope !== 'modal');
  const rows = (scope: string) => {
    const seen = new Set<string>();
    return infos.filter((b) => b.scope === scope).map((b) => ({ label: keyLabel(b.spec), description: b.description }))
      .filter((r) => (seen.has(r.label) ? false : (seen.add(r.label), true)));
  };
  const section = (title: string, list: { label: string; description: string }[]) =>
    list.length === 0 ? null : (
      <div class="help-section">
        <h3>{title}</h3>
        {list.map((r) => (
          <div class="help-row" key={r.label}>
            <kbd>{r.label}</kbd>
            <span>{r.description || '(view action)'}</span>
          </div>
        ))}
      </div>
    );
  return (
    <Overlay label="Help" wide onBackdrop={closeOverlay}>
      <Pane title="Help" focused>
        {section('Global', rows('global'))}
        {section('This view', rows('view'))}
        {section('Lists', rows('list'))}
        <div class="help-section">
          <h3>Chat input (typing; not listed above)</h3>
          <div class="help-row"><kbd>↑</kbd><span>in an empty input: leave it and select the newest capture</span></div>
          <div class="help-row"><kbd>Alt-↑</kbd><span>recall an earlier text (Option on macOS); typed text is kept</span></div>
          <div class="help-row"><kbd>Alt-↓</kbd><span>recall a newer text; past the newest brings your typed text back</span></div>
          <div class="help-row"><kbd>Enter</kbd><span>send</span></div>
        </div>
        <div class="hint">Esc or ? to close</div>
      </Pane>
    </Overlay>
  );
}
