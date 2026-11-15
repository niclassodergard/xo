import { clearFlash, flashMessage } from '../lib/store.ts';

/** Flash messages (store `flash()`): a live region that is always mounted, with an optional action button. */
export function Toasts() {
  const f = flashMessage.value;
  return (
    <div class="toasts">
      <div class={`toast${f?.kind === 'error' ? ' error' : ''}`} role="status" aria-live="polite">
        {f && <span>{f.message}</span>}
        {f?.action && (
          <button type="button" onClick={() => { const a = f.action; clearFlash(); a?.run(); }}>{f.action.label}</button>
        )}
      </div>
    </div>
  );
}
