import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActionsListResponse } from '../../shared/api.ts';
import type { Action, Owner } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { navigate } from '../lib/router.ts';
import { askText, drafts, epoch, errorText, flash, people } from '../lib/store.ts';
import { groupActions, oldestId } from './chat-logic.ts';
import type { ActionRow } from './chat-logic.ts';

const PAGE = 200;

/** Open actions grouped Mine / Waiting for; `t` also shows done ones. */
export default function Actions() {
  const [items, setItems] = useState<Action[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [reopened, setReopened] = useState(false); // editor reopened from a saved draft: retry the save, don't grab focus
  const alive = useRef(true);
  const loadSeq = useRef(0);
  const busy = useRef(new Set<number>());
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => () => { alive.current = false; }, []);

  async function load(done: boolean, before?: number): Promise<void> {
    const e = epoch();
    const seq = ++loadSeq.current;
    const q = `status=${done ? 'all' : 'open'}&limit=${PAGE}${before === undefined ? '' : `&before=${before}`}`;
    try {
      const r = await api.get<ActionsListResponse>(`/api/actions?${q}`);
      if (e !== epoch() || !alive.current || seq !== loadSeq.current) return;
      setItems((cur) => {
        if (before === undefined) return r.actions;
        const have = new Set(cur.map((a) => a.id));
        return [...cur, ...r.actions.filter((a) => !have.has(a.id))];
      });
      setHasMore(r.actions.length >= PAGE);
      setLoaded(true);
      if (before === undefined) {
        // An unsaved edit survived a 401 (or a failed save): reopen it so its editor retries the save.
        const d = drafts.peek();
        const again = r.actions.find((a) => d[`action:${a.id}:text`] !== undefined);
        if (again) { setReopened(true); setEditing(again.id); }
      }
    } catch (err) {
      if (e !== epoch() || !alive.current || seq !== loadSeq.current) return;
      setLoaded(true);
      flash(`Could not load actions: ${errorText(err)}`, 'error');
    }
  }
  useEffect(() => { void load(showDone); }, [showDone]);

  /** One write per action id at a time; the result is applied only in the session it started in. */
  async function write(id: number, op: () => Promise<Action | null>): Promise<void> {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    const e = epoch();
    try {
      const a = await op();
      if (e !== epoch() || !alive.current) return;
      setItems((cur) => {
        if (a === null) return cur.filter((x) => x.id !== id);
        // A done action drops out of the open-only view.
        if (a.status === 'done' && !showDone) return cur.filter((x) => x.id !== id);
        return cur.map((x) => (x.id === id ? a : x));
      });
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
    } finally {
      busy.current.delete(id);
    }
  }

  const toggle = (a: Action) => void write(a.id, () =>
    api.patch<Action>(`/api/actions/${a.id}`, { status: a.status === 'open' ? 'done' : 'open' }));
  const remove = (a: Action) => void write(a.id, async () => { await api.del(`/api/actions/${a.id}`); return null; });

  function add(owner: Owner): void {
    askText(owner === 'me' ? 'New action' : 'New action (waiting for)', (text) => {
      const e = epoch();
      api.post<Action>('/api/actions', { text, owner }).then((a) => {
        if (e !== epoch() || !alive.current) return;
        setItems((cur) => [a, ...cur]);
        flash('Action added');
      }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
    });
  }

  function openPerson(a: Action): void {
    if (a.personId !== null) navigate(`/people/${a.personId}`);
    else flash('No person linked');
  }

  useKeys({
    a: () => add('me'),
    'shift+a': () => add('them'),
    t: () => { setLoaded(false); setShowDone((v) => !v); },
    ...(hasMore ? { o: () => { void load(showDone, oldestId(itemsRef.current)); } } : {}),
  }, { descriptions: { a: 'add action', 'shift+a': 'add action (waiting for)', t: 'show / hide done', o: 'load more' } });

  const names = new Map(people.value.map((p) => [p.id, p.name]));
  const rows = groupActions(items);

  const renderRow = (r: ActionRow) => {
    const a = r.action;
    const who = a.personId !== null ? names.get(a.personId) : undefined;
    return (
      <>
        {r.header && <div class="accent">{`── ${r.header} ──`}</div>}
        {editing === a.id ? (
          <div
            onFocusOut={() => {
              // Stay open while the text is unsaved (failed save), so nothing is silently dropped.
              if (drafts.peek()[`action:${a.id}:text`] === undefined) setEditing(null);
            }}
            onClick={(ev) => ev.stopPropagation()}
          >
            <TextEdit
              id={`action:${a.id}:text`} value={a.text} autofocus={!reopened} label="Action text"
              onSave={(v) => { const e = epoch(); return api.patch<Action>(`/api/actions/${a.id}`, { text: v }).then((u) => {
                if (alive.current && e === epoch()) setItems((cur) => cur.map((x) => (x.id === u.id ? u : x)));
                setEditing(null);
                return u;
              }); }}
            />
          </div>
        ) : (
          <span class={a.status === 'done' ? 'dim' : ''}>
            {`[${a.status === 'done' ? 'x' : ' '}] ${a.text}`}
            {who !== undefined && <span class="dim">{`  · ${who}`}</span>}
          </span>
        )}
      </>
    );
  };

  return (
    <Pane title={showDone ? 'Actions (with done)' : 'Actions'} focused>
      {!loaded ? <div class="empty">Loading…</div> : (
        <SelectableList
          items={rows}
                    empty="No open actions. Press a to add one."
          onOpen={(r) => openPerson(r.action)}
          keyDescriptions={{ x: 'toggle done', e: 'edit text', 'd d': 'delete action', enter: 'open person' }}
          keys={{
            x: (r) => toggle(r.action),
            e: (r) => {
              if (editing === r.action.id) document.querySelector<HTMLElement>('.row.selected .textedit')?.focus();
              setReopened(false);
              setEditing(r.action.id);
            },
            'd d': (r) => remove(r.action),
          }}
          render={renderRow}
        />
      )}
      <div class="hint">x done · e edit · d d delete · a add · A add waiting-for · t show done · Enter person</div>
    </Pane>
  );
}
