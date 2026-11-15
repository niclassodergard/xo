import { useEffect, useRef, useState } from 'preact/hooks';
import type { NoteSummary, NotesListResponse } from '../../shared/api.ts';
import type { Note } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { api } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { navigate } from '../lib/router.ts';
import { askText, epoch, errorText, flash } from '../lib/store.ts';
import { oldestId, oneLine, shortDate } from './chat-logic.ts';

const PAGE = 100;

/** Notes, newest first. Enter opens, `a` creates (and opens) a note, `d d` deletes. */
export default function Notes() {
  const [items, setItems] = useState<NoteSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const alive = useRef(true);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  async function load(before?: number): Promise<void> {
    const e = epoch();
    try {
      const r = await api.get<NotesListResponse>(`/api/notes?limit=${PAGE}${before === undefined ? '' : `&before=${before}`}`);
      if (e !== epoch() || !alive.current) return;
      setItems((cur) => {
        if (before === undefined) return r.notes;
        const have = new Set(cur.map((n) => n.id));
        return [...cur, ...r.notes.filter((n) => !have.has(n.id))];
      });
      setHasMore(r.notes.length >= PAGE);
      setLoaded(true);
    } catch (err) {
      if (e !== epoch() || !alive.current) return;
      setLoaded(true);
      flash(`Could not load notes: ${errorText(err)}`, 'error');
    }
  }
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []);

  function add(): void {
    askText('New note', (text) => {
      const e = epoch();
      api.post<Note>('/api/notes', { bodyMd: text }).then((n) => {
        if (e === epoch()) navigate(`/notes/${n.id}`);
      }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
    });
  }

  function remove(n: NoteSummary): void {
    const e = epoch();
    api.del(`/api/notes/${n.id}`).then(() => {
      if (e !== epoch() || !alive.current) return;
      setItems((cur) => cur.filter((x) => x.id !== n.id));
      flash('Note deleted');
    }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
  }

  useKeys({
    a: add,
    ...(hasMore ? { o: () => { void load(oldestId(itemsRef.current)); } } : {}),
  }, { descriptions: { a: 'new note', o: 'load more' } });

  return (
    <Pane title="Notes" focused>
      {!loaded ? <div class="empty">Loading…</div> : (
        <SelectableList
          items={items}
          empty="No notes yet. Press a to add one, or capture one in chat."
          onOpen={(n) => navigate(`/notes/${n.id}`)}
          keyDescriptions={{ 'd d': 'delete note' }}
          keys={{ 'd d': remove }}
          render={(n) => (
            <>
              <span>{n.title}</span>
              <span class="dim">{`  ${shortDate(n.createdAt)}`}</span>
              {oneLine(n.preview) !== '' && oneLine(n.preview) !== oneLine(n.title) && <div class="dim">{oneLine(n.preview)}</div>}
            </>
          )}
        />
      )}
      <div class="hint">Enter open · a new · d d delete{hasMore ? ' · o load more' : ''}</div>
    </Pane>
  );
}
