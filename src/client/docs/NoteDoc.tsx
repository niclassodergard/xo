import { useEffect, useRef, useState } from 'preact/hooks';
import type { Id, Note } from '../../shared/types.ts';
import { ItemPicker } from '../components/ItemPicker.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { navigate, route } from '../lib/router.ts';
import {
  askConfirm, clearDraft, epoch, errorText, flash, personName, projectTitle, projects, people, refreshNav, refreshProjects, usePanelTitle,
} from '../lib/store.ts';
import '../styles/docs-work.css';

/** One note: title, body (autosaved), person and project, delete. */
export default function NoteDoc() {
  const id = Number(route.value.params['id']);
  const [note, setNote] = useState<Note | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading');
  const [picking, setPicking] = useState<'person' | 'project' | null>(null);
  const [titleKey, setTitleKey] = useState(0);
  const deleted = useRef(false);
  void people.value;
  void projects.value;
  usePanelTitle(note?.title || 'Note');

  const load = () => {
    const e = epoch();
    setState('loading');
    api.get<Note>(`/api/notes/${id}`).then((n) => {
      if (e !== epoch()) return;
      setNote(n);
      setState('ready');
    }, (err: unknown) => {
      if (e !== epoch()) return;
      setState(err instanceof ApiError && err.status === 404 ? 'missing' : 'error');
    });
  };
  useEffect(load, [id]);

  // Saves return the API promise: "saved" means resolved. A note deleted meanwhile has nothing to save to.
  const saveBody = async (bodyMd: string) => {
    if (deleted.current) return;
    const n = await api.patch<Note>(`/api/notes/${id}`, { bodyMd });
    if (!deleted.current) setNote((cur) => (cur ? { ...cur, updatedAt: n.updatedAt } : cur));
  };
  const saveTitle = async (title: string) => {
    if (deleted.current) return;
    if (title.trim() === '') {
      // Blank is never saved: say so, drop the draft and show the stored title again.
      flash('A note needs a title', 'error');
      clearDraft(`note:${id}:title`, title);
      setTitleKey((k) => k + 1);
      return;
    }
    const e = epoch();
    const n = await api.patch<Note>(`/api/notes/${id}`, { title });
    if (deleted.current || e !== epoch()) return;
    setNote((cur) => (cur ? { ...cur, title: n.title, updatedAt: n.updatedAt } : cur));
    void refreshNav(); // Recents and Pinned show titles
  };

  const link = async (body: { personId: Id | null } | { projectId: Id | null }) => {
    const e = epoch();
    try {
      const n = await api.patch<Note>(`/api/notes/${id}`, body);
      if (e !== epoch()) return;
      setNote((cur) => (cur ? { ...cur, personId: n.personId, projectId: n.projectId, updatedAt: n.updatedAt } : cur));
      void refreshProjects();
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
    }
  };

  const remove = () => {
    askConfirm('Delete this note?', () => {
      const e = epoch();
      void api.del(`/api/notes/${id}`).then(() => {
        deleted.current = true;
        if (e === epoch()) { void refreshProjects(); navigate('/notes', { replace: true }); }
      }, (err: unknown) => { if (e === epoch()) flash(errorText(err), 'error'); });
    });
  };

  if (state === 'loading') return <p class="muted">Loading…</p>;
  if (state === 'missing') return <p class="muted">This note no longer exists.</p>;
  if (state === 'error' || !note) {
    return (
      <div class="work-error" role="alert">
        <span class="error-text">Could not load the note.</span>
        <button type="button" class="btn" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div class="work-doc work-note-doc">
      <TextEdit
        key={titleKey} id={`note:${note.id}:title`} label="Note title" value={note.title} onSave={saveTitle}
      />
      <TextEdit
        id={`note:${note.id}:body`} label="Note body" value={note.bodyMd} multiline autosaveMs={800} onSave={saveBody}
      />
      <div class="work-links">
        <div class="work-link">
          <span class="muted">Person</span>
          <span>{personName(note.personId) ?? 'None'}</span>
          <button type="button" class="btn" onClick={() => setPicking('person')}>Change person</button>
        </div>
        <div class="work-link">
          <span class="muted">Project</span>
          <span>{projectTitle(note.projectId) ?? 'None'}</span>
          <button type="button" class="btn" onClick={() => setPicking('project')}>Change project</button>
        </div>
      </div>
      <div class="work-danger">
        <button type="button" class="btn danger" onClick={remove}>Delete note</button>
      </div>
      {picking === 'person' && (
        <ItemPicker
          kind="person" allowNone onCancel={() => setPicking(null)}
          onPick={(pid) => { setPicking(null); if (pid !== note.personId) void link({ personId: pid }); }}
        />
      )}
      {picking === 'project' && (
        <ItemPicker
          kind="project" allowNone onCancel={() => setPicking(null)}
          onPick={(pid) => { setPicking(null); if (pid !== note.projectId) void link({ projectId: pid }); }}
        />
      )}
    </div>
  );
}
