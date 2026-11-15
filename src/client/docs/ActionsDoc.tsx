import { effect, signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ActionsListResponse } from '../../shared/api.ts';
import type { Action, Id } from '../../shared/types.ts';
import { Chip } from '../components/Chip.tsx';
import { ItemPicker } from '../components/ItemPicker.tsx';
import { List } from '../components/List.tsx';
import { api } from '../lib/api.ts';
import { appendPage, mayHaveMore, oldestId } from '../lib/format.ts';
import type { RowAction } from '../lib/row-actions.ts';
import { epoch, errorText, flash, personName, projects, refreshProjects, session, usePanelTitle } from '../lib/store.ts';
import { EditActionDialog } from './EditActionDialog.tsx';
import {
  actionRowActions, actionsQuery, addAction, beginToggle, groupActionsByProject, OPEN_LIMIT, PAGE_SIZE, removeAction, replaceAction, visibleActions,
} from './actions-logic.ts';
import type { ActionGroup } from './actions-logic.ts';
import '../styles/docs-work.css';

/** The person filter outlives the document (closing and reopening Actions keeps it), but not the session. */
const personFilter = signal<Id | null>(null);
effect(() => { if (session.value === null) personFilter.value = null; });

type Picking = { kind: 'person' | 'project'; action: Action } | { kind: 'filter' };

function meta(a: Action): string {
  const who = personName(a.personId);
  if (a.owner === 'them') return who ? `Waiting on ${who}` : 'Waiting';
  return who ?? '';
}

/** Open actions grouped by project, filterable by person. */
export default function ActionsDoc() {
  usePanelTitle('Actions');
  const [items, setItems] = useState<Action[] | null>(null);
  const [doneCursor, setDoneCursor] = useState<Id | null>(null);
  const [openCapped, setOpenCapped] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [editing, setEditing] = useState<Action | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const inflight = useRef(new Set<Id>());
  const generation = useRef(0);
  const filter = personFilter.value;
  const projectList = projects.value;

  // Open actions are loaded in one request (up to OPEN_LIMIT), so nothing is ever inserted above rows already
  // shown. Only done actions are paged ("Load more", newest first), and only while "Show done" is on.
  const load = () => {
    const g = ++generation.current;
    const e = epoch();
    setLoadError(null);
    const open = api.get<ActionsListResponse>(`/api/actions?${actionsQuery({ status: 'open', personId: filter })}`);
    const done = showDone ? api.get<ActionsListResponse>(`/api/actions?${actionsQuery({ status: 'done', personId: filter })}`) : null;
    Promise.all([open, done]).then(([o, d]) => {
      if (e !== epoch() || g !== generation.current) return;
      setItems(d ? appendPage(o.actions, d.actions) : o.actions);
      setOpenCapped(o.actions.length >= OPEN_LIMIT);
      setDoneCursor(d && mayHaveMore(d.actions.length, PAGE_SIZE) ? oldestId(d.actions) ?? null : null);
    }, (err: unknown) => {
      if (e === epoch() && g === generation.current) setLoadError(errorText(err));
    });
  };
  useEffect(load, [showDone, filter]);

  const loadMore = async () => {
    if (doneCursor === null || loadingMore) return;
    const g = generation.current;
    const e = epoch();
    setLoadingMore(true);
    try {
      const r = await api.get<ActionsListResponse>(`/api/actions?${actionsQuery({ status: 'done', personId: filter, before: doneCursor })}`);
      if (e !== epoch() || g !== generation.current) return;
      setItems((cur) => (cur ? appendPage(cur, r.actions) : cur));
      setDoneCursor(mayHaveMore(r.actions.length, PAGE_SIZE) ? oldestId(r.actions) ?? null : null);
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  /** A write that returns the updated action. One at a time per action; rejects on failure (the List reports it). */
  const patch = async (a: Action, body: Record<string, unknown>) => {
    if (inflight.current.has(a.id)) return;
    inflight.current.add(a.id);
    const e = epoch();
    try {
      const next = await api.patch<Action>(`/api/actions/${a.id}`, body);
      if (e !== epoch()) return;
      setItems((cur) => (cur ? replaceAction(cur, next) : cur));
      void refreshProjects();
    } finally {
      inflight.current.delete(a.id);
    }
  };

  const toggle = async (a: Action) => {
    const started = beginToggle(items ?? [], a.id, inflight.current, new Date().toISOString());
    if (!started) return; // already running: nothing changes
    const e = epoch();
    setItems((cur) => (cur ? replaceAction(cur, started.actions.find((x) => x.id === a.id)!) : cur));
    try {
      const next = await api.patch<Action>(`/api/actions/${a.id}`, { status: started.status });
      if (e !== epoch()) return;
      setItems((cur) => (cur ? replaceAction(cur, next) : cur));
      void refreshProjects();
    } catch (err) {
      if (e === epoch()) setItems((cur) => (cur ? replaceAction(cur, started.previous) : cur));
      throw err;
    } finally {
      inflight.current.delete(a.id);
    }
  };

  const remove = async (a: Action) => {
    if (inflight.current.has(a.id)) return;
    inflight.current.add(a.id);
    const e = epoch();
    try {
      await api.del(`/api/actions/${a.id}`);
      if (e !== epoch()) return;
      setItems((cur) => (cur ? removeAction(cur, a.id) : cur));
      void refreshProjects();
    } finally {
      inflight.current.delete(a.id);
    }
  };

  const rowActions = (a: Action): RowAction[] => actionRowActions(a, {
    toggle,
    edit: (x) => setEditing(x),
    pickProject: (x) => setPicking({ kind: 'project', action: x }),
    pickPerson: (x) => setPicking({ kind: 'person', action: x }),
    toggleOwner: (x) => patch(x, { owner: x.owner === 'me' ? 'them' : 'me' }),
    remove,
  }, { withProject: true });

  const addTo = (g: ActionGroup) => async (text: string) => {
    const e = epoch();
    try {
      const created = await api.post<Action>('/api/actions', {
        text, ...(g.projectId !== null ? { projectId: g.projectId } : {}), ...(filter !== null ? { personId: filter } : {}),
      });
      if (e !== epoch()) return;
      setItems((cur) => (cur ? addAction(cur, created) : cur));
      void refreshProjects();
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // the add field keeps the text
    }
  };

  const shown = items ? visibleActions(items, filter, showDone) : [];
  const groups = groupActionsByProject(shown, projectList);

  return (
    <div class="work-doc">
      <div class="work-toolbar">
        <Chip
          label={filter === null ? 'Person: any' : `Person: ${personName(filter) ?? 'unknown'}`}
          highlighted={filter !== null} onClick={() => setPicking({ kind: 'filter' })}
        />
        <label class="work-toggle">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone((e.target as HTMLInputElement).checked)} />
          <span>Show done</span>
        </label>
      </div>
      {loadError !== null && (
        <div class="work-error" role="alert">
          <span class="error-text">{`Could not load actions: ${loadError}`}</span>
          <button type="button" class="btn" onClick={load}>Retry</button>
        </div>
      )}
      {items === null && loadError === null && <p class="muted">Loading…</p>}
      {items !== null && groups.map((g) => (
        <section key={g.key} class="work-group" aria-label={g.title}>
          <h3 class="work-group-title">
            {g.title}
            {g.status === 'on_hold' && <span class="muted">{' (on hold)'}</span>}
            {g.status === 'done' && <span class="muted">{' (done)'}</span>}
          </h3>
          <List
            items={g.actions}
            label={`Actions: ${g.title}`}
            empty="No actions."
            draftId={`actions:${g.key}:${filter ?? 'any'}:add`}
            addPlaceholder={`Add an action to ${g.title}`}
            onAdd={addTo(g)}
            render={(a) => (
              <span class={`work-action${a.status === 'done' ? ' done' : ''}`}>
                <span class="work-check" aria-hidden="true">{a.status === 'done' ? '☑' : '☐'}</span>
                <span class="work-text">{a.text}</span>
                {meta(a) && <span class="muted work-meta">{meta(a)}</span>}
                {a.status === 'done' && <span class="sr-only">(done)</span>}
              </span>
            )}
            actions={rowActions}
          />
        </section>
      ))}
      {items !== null && openCapped && <p class="muted">{`Showing the ${OPEN_LIMIT} newest open actions.`}</p>}
      {items !== null && doneCursor !== null && (
        <button type="button" class="btn" disabled={loadingMore} onClick={() => void loadMore()}>Load more done</button>
      )}

      {editing && (
        <EditActionDialog
          label="Edit action" initial={editing.text}
          onCancel={() => setEditing(null)}
          onSubmit={(v) => {
            const a = editing;
            setEditing(null);
            if (v !== a.text) void patch(a, { text: v }).catch((err: unknown) => flash(errorText(err), 'error'));
          }}
        />
      )}
      {picking?.kind === 'project' && (
        <ItemPicker
          kind="project" allowNone onCancel={() => setPicking(null)}
          onPick={(id) => {
            const a = picking.action;
            setPicking(null);
            if (id !== a.projectId) void patch(a, { projectId: id }).catch((err: unknown) => flash(errorText(err), 'error'));
          }}
        />
      )}
      {picking?.kind === 'person' && (
        <ItemPicker
          kind="person" allowNone onCancel={() => setPicking(null)}
          onPick={(id) => {
            const a = picking.action;
            setPicking(null);
            if (id !== a.personId) void patch(a, { personId: id }).catch((err: unknown) => flash(errorText(err), 'error'));
          }}
        />
      )}
      {picking?.kind === 'filter' && (
        <ItemPicker
          kind="person" allowNone onCancel={() => setPicking(null)}
          onPick={(id) => { setPicking(null); personFilter.value = id; }}
        />
      )}
    </div>
  );
}
