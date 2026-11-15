// Tracks what has really been saved for an editor. "Saved" advances only when onSave resolves, so a
// failed save (401, network, 403, 5xx) leaves the draft dirty and it can be retried later.

export interface DraftSaver {
  /** Last value known to be saved. */
  saved(): string;
  /** Tell the saver the authoritative value changed (e.g. loaded from the server). */
  reset(value: string): void;
  isDirty(draft: string): boolean;
  /** Resolves true if the value is saved afterwards (already saved, or onSave resolved), false on failure. */
  save(value: string): Promise<boolean>;
}

export function createDraftSaver(
  initial: string,
  getOnSave: () => (value: string) => unknown,
  hooks: {
    onSaved?: (value: string) => void; onFailed?: (error: unknown) => void;
    /** Checked before every save; false = refuse silently (e.g. the session ended since this editor mounted). */
    canSave?: () => boolean;
  } = {},
): DraftSaver {
  let saved = initial;
  let inflight: { value: string; promise: Promise<boolean> } | null = null;
  return {
    saved: () => saved,
    reset(value) { saved = value; },
    isDirty: (draft) => draft !== saved,
    save(value) {
      if (value === saved) return Promise.resolve(true);
      if (hooks.canSave && !hooks.canSave()) return Promise.resolve(false);
      if (inflight && inflight.value === value) return inflight.promise;
      const run = async (): Promise<boolean> => {
        try {
          await getOnSave()(value);
          saved = value;
          hooks.onSaved?.(value);
          return true;
        } catch (e) {
          hooks.onFailed?.(e);
          return false;
        }
      };
      const entry = { value, promise: run() };
      inflight = entry;
      void entry.promise.then(() => { if (inflight === entry) inflight = null; });
      return entry.promise;
    },
  };
}
