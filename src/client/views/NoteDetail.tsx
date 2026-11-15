import { useEffect, useRef, useState } from 'preact/hooks';
import type { Note } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { back, navigate, route } from '../lib/router.ts';
import { epoch, errorText, flash, people } from '../lib/store.ts';
import { shortDate } from './chat-logic.ts';

/** One note: title and body are always-live editors (saved on Esc/blur); `e` edits the body, `t` the title. */
export default function NoteDetail() {
  const id = route.value.params.id ?? '';
  const [note, setNote] = useState<Note | null>(null);
  const [missing, setMissing] = useState(false);
  const alive = useRef(true);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    const e = epoch();
    api.get<Note>(`/api/notes/${id}`).then((n) => {
      if (e === epoch() && alive.current) setNote(n);
    }).catch((err) => {
      if (e !== epoch() || !alive.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else flash(`Could not load note: ${errorText(err)}`, 'error');
    });
    return () => { alive.current = false; };
  }, [id]);

  const focusField = (sel: string) => {
    const el = box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(sel);
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };

  function remove(): void {
    const e = epoch();
    api.del(`/api/notes/${id}`).then(() => {
      if (e !== epoch()) return;
      flash('Note deleted');
      navigate('/notes', { replace: true });
    }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
  }

  const person = note?.personId != null ? people.value.find((p) => p.id === note.personId) : undefined;
  useKeys({
    e: () => focusField('textarea'),
    t: () => focusField('input'),
    'd d': remove,
    ...(note?.personId != null ? { p: () => navigate(`/people/${note.personId}`) } : {}),
    q: back,
  }, { descriptions: { e: 'edit body', t: 'edit title', 'd d': 'delete note', p: 'open person', q: 'back' } });

  if (missing) return <Pane title="Note" focused><div class="empty">This note no longer exists. Esc to go back.</div></Pane>;
  if (!note) return <Pane title="Note" focused><div class="empty">Loading…</div></Pane>;

  const save = (field: 'title' | 'bodyMd') => (v: string) => {
    const e = epoch();
    return api.patch<Note>(`/api/notes/${note.id}`, { [field]: v }).then((n) => {
      // Merge only the saved field so a slower response cannot overwrite the other editor's text.
      if (e === epoch() && alive.current) setNote((cur) => (cur ? { ...cur, [field]: n[field], updatedAt: n.updatedAt } : cur));
      return n;
    });
  };

  return (
    <Pane title={`Note · ${shortDate(note.createdAt)}`} focused>
      <div ref={box}>
        <TextEdit id={`note:${note.id}:title`} value={note.title} label="Title" onSave={save('title')} />
        {person && <div class="dim">{`About ${person.name}  (p to open)`}</div>}
        <TextEdit id={`note:${note.id}:body`} value={note.bodyMd} label="Note body" multiline onSave={save('bodyMd')} />
      </div>
      <div class="hint">e edit body · t edit title · Esc save and leave field · Ctrl-Enter save · d d delete · q back</div>
    </Pane>
  );
}
