import { useEffect, useRef, useState } from 'preact/hooks';
import { LIMITS } from '../../shared/api.ts';
import type { NoteSummary, NotesListResponse } from '../../shared/api.ts';
import type { Id, Note } from '../../shared/types.ts';
import { List } from '../components/List.tsx';
import { api } from '../lib/api.ts';
import { appendPage, mayHaveMore, oldestId, oneLine, shortDate } from '../lib/format.ts';
import { openDoc } from '../lib/nav.ts';
import type { RowAction } from '../lib/row-actions.ts';
import { epoch, errorText, flash, personName, projectTitle, projects, people, usePanelTitle } from '../lib/store.ts';
import '../styles/docs-work.css';

const PAGE = 100;

function summaryOf(n: Note): NoteSummary {
  return {
    id: n.id, title: n.title, preview: Array.from(n.bodyMd).slice(0, LIMITS.notePreview).join(''),
    personId: n.personId, projectId: n.projectId, createdAt: n.createdAt, updatedAt: n.updatedAt,
  };
}

/** All notes, newest first, with previews and person / project labels. */
export default function NotesDoc() {
  usePanelTitle('Notes');
  const [items, setItems] = useState<NoteSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inflight = useRef(new Set<Id>());
  // Names come from the stores; reading the signals here re-renders the labels when they load.
  void people.value;
  void projects.value;

  const load = () => {
    const e = epoch();
    setError(null);
    api.get<NotesListResponse>(`/api/notes?limit=${PAGE}`).then((r) => {
      if (e !== epoch()) return;
      setItems(r.notes);
      setMore(mayHaveMore(r.notes.length, PAGE));
    }, (err: unknown) => { if (e === epoch()) setError(errorText(err)); });
  };
  useEffect(load, []);

  const loadMore = async () => {
    const before = items ? oldestId(items) : undefined;
    if (before === undefined || loadingMore) return;
    const e = epoch();
    setLoadingMore(true);
    try {
      const r = await api.get<NotesListResponse>(`/api/notes?limit=${PAGE}&before=${before}`);
      if (e !== epoch()) return;
      setItems((cur) => (cur ? appendPage(cur, r.notes) : cur));
      setMore(mayHaveMore(r.notes.length, PAGE));
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  const remove = async (n: NoteSummary) => {
    if (inflight.current.has(n.id)) return;
    inflight.current.add(n.id);
    const e = epoch();
    try {
      await api.del(`/api/notes/${n.id}`);
      if (e === epoch()) setItems((cur) => (cur ? cur.filter((x) => x.id !== n.id) : cur));
    } finally {
      inflight.current.delete(n.id);
    }
  };

  const rowActions = (n: NoteSummary): RowAction[] => [
    { id: 'open', label: 'Open', run: () => openDoc({ kind: 'note', id: n.id }) },
    { id: 'delete', label: 'Delete', danger: true, run: () => remove(n) },
  ];

  const add = async (text: string) => {
    const e = epoch();
    try {
      const created = await api.post<Note>('/api/notes', { bodyMd: text });
      if (e !== epoch()) return;
      setItems((cur) => (cur && !cur.some((x) => x.id === created.id) ? [summaryOf(created), ...cur] : cur));
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // the add field keeps the text
    }
  };

  return (
    <div class="work-doc">
      {error !== null && (
        <div class="work-error" role="alert">
          <span class="error-text">{`Could not load notes: ${error}`}</span>
          <button type="button" class="btn" onClick={load}>Retry</button>
        </div>
      )}
      {items === null && error === null && <p class="muted">Loading…</p>}
      {items !== null && (
        <List
          items={items}
          label="Notes"
          empty="No notes yet."
          draftId="notes:all:add"
          addPlaceholder="Add a note"
          onAdd={add}
          render={(n) => {
            const labels = [personName(n.personId), projectTitle(n.projectId)].filter((x): x is string => !!x);
            return (
              <span class="work-note">
                <span class="work-note-title">{n.title}</span>
                {oneLine(n.preview, 140) && oneLine(n.preview, 140) !== n.title && <span class="muted work-note-preview">{oneLine(n.preview, 140)}</span>}
                <span class="muted work-meta">{[shortDate(n.updatedAt), ...labels].filter(Boolean).join(' · ')}</span>
              </span>
            );
          }}
          actions={rowActions}
        />
      )}
      {items !== null && more && (
        <button type="button" class="btn" disabled={loadingMore} onClick={() => void loadMore()}>Load more</button>
      )}
    </div>
  );
}
