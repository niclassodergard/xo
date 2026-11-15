import { useKeys } from '../lib/keys.ts';
import { SHORTCUT_GROUPS, SHORTCUTS } from '../lib/keymap.ts';
import { closeOverlay } from '../lib/store.ts';
import { Overlay } from './Overlay.tsx';

/** Keyboard shortcuts, generated from lib/keymap.ts (the one list the README also follows). */
export function Help() {
  useKeys({ esc: closeOverlay }, { scope: 'modal' });
  return (
    <Overlay label="Shortcuts" wide onBackdrop={closeOverlay}>
      <h2>Shortcuts</h2>
      {SHORTCUT_GROUPS.map((group) => (
        <div class="help-section" key={group}>
          <h3>{group}</h3>
          {SHORTCUTS.filter((s) => s.group === group).map((s) => (
            <div class="help-row" key={s.keys}>
              <kbd>{s.keys}</kbd>
              <span>{s.description}</span>
            </div>
          ))}
        </div>
      ))}
      <div class="hint">Esc closes this.</div>
    </Overlay>
  );
}
