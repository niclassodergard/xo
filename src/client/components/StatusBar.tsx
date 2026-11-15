import { mode, pendingKeys } from '../lib/keys.ts';
import { clearFlash, flashMessage, openPalette, toggleHelp } from '../lib/store.ts';
import VoiceIndicator from '../voice/VoiceIndicator.tsx';

const LABEL = { normal: 'NORMAL', insert: 'INSERT', command: 'COMMAND' } as const;

export function StatusBar() {
  const f = flashMessage.value;
  const m = mode.value;
  const pending = pendingKeys.value;
  return (
    <footer class="statusbar">
      <span class={`mode mode-${m}`}>{LABEL[m]}</span>
      {pending && <span class="pending" aria-hidden="true">{pending}…</span>}
      {/* Always mounted so screen readers announce changes. */}
      <span class={`flash ${f?.kind ?? ''}`} role="status" aria-live="polite">{f?.message ?? ''}</span>
      {f?.action && <button type="button" class="tbtn" onClick={() => { const a = f.action; clearFlash(); a?.run(); }}>{f.action.label}</button>}
      {!f && !pending && <span class="hints">g c/a/n/p go · / search · : cmd · ? help</span>}
      <span class="spacer" />
      <VoiceIndicator />
      <button type="button" class="tbtn" onClick={openPalette} aria-label="Command palette">:</button>
      <button type="button" class="tbtn" onClick={toggleHelp} aria-label="Help">?</button>
    </footer>
  );
}
