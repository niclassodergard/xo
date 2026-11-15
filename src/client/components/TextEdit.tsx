import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createDraftSaver } from '../lib/draft-saver.ts';
import { composing } from '../lib/keys.ts';
import { clearDraft, drafts, epoch, errorText, flash, session, syncDraft } from '../lib/store.ts';

/**
 * Esc or blur saves (only if changed); Enter saves when single-line, Ctrl/Cmd+Enter when multiline.
 * Also saves on unmount. `onChange` fires on every edit; `autosaveMs` saves after that long without typing.
 *
 * Rules for views:
 * - Render a TextEdit only once its `value` is loaded (never with a placeholder value for server data).
 * - `onSave` must return the API promise (`(v) => api.patch(...)`), never fire and forget: "saved" means
 *   the promise resolved. A failed save leaves the draft dirty; it is retried on the next blur/unmount
 *   and by the remounted editor after re-login.
 * - `id` = `<kind>:<entityId>:<field>`, e.g. `meeting:7:notes` or `note:12:body`. With an id the
 *   unsaved text is kept in the store's `drafts` signal, so it survives the views being unmounted by a
 *   401 and is re-applied and retried after re-login. The entry is dropped when the text equals the
 *   saved value again.
 * - An instance never saves after the session it was mounted in has ended (epoch check), so text typed
 *   before a logout cannot be sent later, not even after logging in again. The remounted instance does
 *   the post-login retry.
 */
export function TextEdit(props: {
  value: string; onSave: (v: string) => Promise<unknown>; onChange?: (v: string) => void; autosaveMs?: number;
  multiline?: boolean; placeholder?: string; autofocus?: boolean; label?: string; id?: string;
}) {
  const id = props.id;
  const mountEpoch = useRef(epoch());
  const pending = id ? drafts.peek()[id] : undefined; // draft left over from before a 401
  const [draft, setDraftState] = useState(pending ?? props.value);
  const draftRef = useRef(draft);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const onSaveRef = useRef(props.onSave);
  onSaveRef.current = props.onSave;
  const saver = useRef<ReturnType<typeof createDraftSaver> | null>(null);
  if (!saver.current) {
    saver.current = createDraftSaver(props.value, () => (v) => onSaveRef.current(v), {
      onSaved: (v) => { if (id) clearDraft(id, v); },
      canSave: () => epoch() === mountEpoch.current && session.peek() !== null,
      onFailed: (e) => { if (session.peek()) flash(errorText(e), 'error'); },
    });
  }
  const s = saver.current;

  const save = () => { clearTimeout(timer.current); void s.save(draftRef.current); };

  // Authoritative value changed (loaded/saved elsewhere): adopt it unless the user has unsaved text.
  useEffect(() => {
    if (draftRef.current === props.value) {
      s.reset(props.value);
      if (id) syncDraft(id, props.value, props.value);
    } else if (!focused.current && !s.isDirty(draftRef.current)) {
      s.reset(props.value);
      draftRef.current = props.value;
      setDraftState(props.value);
    } else if (!s.isDirty(draftRef.current)) {
      s.reset(props.value);
    }
  }, [props.value]);
  useLayoutEffect(() => {
    if (props.autofocus && el.current) {
      el.current.focus();
      el.current.setSelectionRange(el.current.value.length, el.current.value.length);
    }
  }, []);
  // Retry a dirty draft whenever a session exists (mount after re-login, or the token changed).
  const token = session.value?.csrfToken;
  useEffect(() => {
    if (token && !focused.current && s.isDirty(draftRef.current)) save();
  }, [token]);
  // Save pending edits when the field goes away (navigation, view change).
  // (The saver refuses if the session ended; the autosave timer must not outlive the component.)
  useEffect(() => () => {
    clearTimeout(timer.current);
    if (session.peek() !== null) void s.save(draftRef.current);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === 'Escape') { e.preventDefault(); el.current?.blur(); return; }
    if (e.key === 'Enter' && (!props.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      el.current?.blur();
    }
  };
  const common = {
    ref: el, value: draft, placeholder: props.placeholder, class: 'textedit', spellcheck: false,
    'aria-label': props.label ?? props.placeholder ?? 'text',
    onInput: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      draftRef.current = v;
      setDraftState(v);
      if (id) syncDraft(id, v, s.saved());
      props.onChange?.(v);
      if (props.autosaveMs) {
        clearTimeout(timer.current);
        timer.current = setTimeout(save, props.autosaveMs);
      }
    },
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; save(); },
    onKeyDown,
  };
  return props.multiline ? <textarea {...common} rows={6} /> : <input type="text" {...common} />;
}
