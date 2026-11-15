// Focus targets: components that own a well-known focus spot (the composer, the document panel) register
// a getter; everything else calls focusTarget(name). Replaces v0.1's useFocusRequest.
//
// focusTarget focuses synchronously when the target is registered (so a following keystroke already lands
// there). When it is not (yet) rendered, the request is queued for up to 1 s and runs when the target
// registers, which covers "navigate, then focus the thing that is about to render".

export type FocusName = 'composer' | 'panel';
export const FOCUS_QUEUE_TTL_MS = 1000;

const targets = new Map<FocusName, () => HTMLElement | null>();
const pending = new Map<FocusName, number>(); // name -> expiry (ms since epoch)

function tryFocus(name: FocusName): boolean {
  const el = targets.get(name)?.() ?? null;
  if (!el || el.isConnected === false) return false;
  el.focus();
  return true;
}

/** Register the element that `focusTarget(name)` focuses. Returns the unregister function. */
export function registerFocusTarget(name: FocusName, getEl: () => HTMLElement | null): () => void {
  targets.set(name, getEl);
  const expiry = pending.get(name);
  if (expiry !== undefined) {
    if (Date.now() > expiry) pending.delete(name);
    else if (tryFocus(name)) pending.delete(name);
  }
  return () => { if (targets.get(name) === getEl) targets.delete(name); };
}

/**
 * Focus the named target. Returns true if it was focused now. Otherwise, and unless `queue` is false,
 * the request waits (1 s) for the target to register. Pass `{ queue: false }` where "not rendered" must
 * mean "do nothing" (type-to-composer).
 */
export function focusTarget(name: FocusName, opts: { queue?: boolean } = {}): boolean {
  if (tryFocus(name)) { pending.delete(name); return true; }
  if (opts.queue !== false) pending.set(name, Date.now() + FOCUS_QUEUE_TTL_MS);
  return false;
}

/** Drop every queued focus request (the session ended: nothing behind the lock may take focus later). */
export function clearPendingFocus(): void {
  pending.clear();
}

/** Test helper: forget every registration and queued request. */
export function resetFocusTargets(): void {
  targets.clear();
  pending.clear();
}
