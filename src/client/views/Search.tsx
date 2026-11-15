import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { SearchHit, SearchRequest, SearchResponse } from '../../shared/api.ts';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { api } from '../lib/api.ts';
import { composing } from '../lib/keys.ts';
import { navigate } from '../lib/router.ts';
import { epoch, errorText, flash, searchQuery, useFocusRequest } from '../lib/store.ts';
import { hitTarget, oneLine, SEARCH_DEBOUNCE_MS, searchTerm } from './chat-logic.ts';

/** Search: the query lives in the `searchQuery` signal (never the URL), debounced, sent with POST. */
export default function Search() {
  const q = searchQuery.value;
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const alive = useRef(true);

  useFocusRequest('search', () => input.current);
  useLayoutEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; seq.current++; }; }, []);

  async function run(term: string, id: number): Promise<void> {
    if (id !== seq.current) return; // superseded before it started
    const e = epoch();
    setState('busy');
    try {
      const body: SearchRequest = { q: term };
      const r = await api.post<SearchResponse>('/api/search', body);
      // Late answers (older query, left the view, session ended) are dropped.
      if (e !== epoch() || !alive.current || id !== seq.current) return;
      setHits(r.results);
      setState('done');
    } catch (err) {
      if (e !== epoch() || !alive.current || id !== seq.current) return;
      setState('idle');
      flash(`Search failed: ${errorText(err)}`, 'error');
    }
  }

  // Debounced search on every change of the query (also re-runs the restored query after a re-login).
  useEffect(() => {
    const term = searchTerm(q);
    const id = ++seq.current;
    if (term === null) { setHits([]); setState('idle'); return undefined; }
    const timer = setTimeout(() => { void run(term, id); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e) || e.key !== 'Enter') return;
    e.preventDefault();
    const term = searchTerm(searchQuery.peek());
    // Search now (skipping the debounce) and leave the input so j/k and Enter work on the results.
    if (term !== null) void run(term, ++seq.current);
    input.current?.blur();
  };

  const open = (h: SearchHit) => {
    const t = hitTarget(h);
    if (t) navigate(t); else flash('Nothing to open');
  };

  const term = searchTerm(q);
  return (
    <Pane title="Search" focused>
      <div class="prompt-line">
        <span class="accent" aria-hidden="true">/</span>
        <input
          ref={input} class="textedit" type="text" value={q} spellcheck={false} autocomplete="off"
          maxLength={200} placeholder="search notes, actions, people, meetings…" aria-label="Search"
          onInput={(e) => { searchQuery.value = (e.target as HTMLInputElement).value; }}
          onKeyDown={onKeyDown}
        />
      </div>
      {term === null ? <div class="empty">Type at least 2 characters.</div>
        : state === 'busy' && hits.length === 0 ? <div class="empty">Searching…</div>
        : (
          <SelectableList
            items={hits.map((hit) => ({ id: `${hit.kind}:${hit.id}`, hit }))}
            empty="No matches."
            onOpen={(r) => open(r.hit)}
            render={({ hit: h }) => (
              <>
                <span class="dim">{`[${h.kind}] `}</span>
                <span>{h.title}</span>
                {h.archived && <span class="dim">{' (archived)'}</span>}
                {oneLine(h.snippet) !== '' && <div class="dim">{oneLine(h.snippet)}</div>}
              </>
            )}
          />
        )}
      <div class="hint">Enter search and select results · j/k move · Enter open · Esc leave input</div>
    </Pane>
  );
}
