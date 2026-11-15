import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, AgendaItem, Meeting, MeetingDetail } from '../../shared/types.ts';
import { List } from '../components/List.tsx';
import type { ListAdd } from '../components/List.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { formatWhen, oneLine } from '../lib/format.ts';
import { openDoc } from '../lib/nav.ts';
import { route } from '../lib/router.ts';
import { askConfirm, epoch, errorText, flash, projects, refreshProjects, usePanelTitle } from '../lib/store.ts';
import { groupActionsByProject } from './actions-logic.ts';
import type { MeetingView } from './meeting-logic.ts';
import {
  agendaProgress, buildView, mergeAgenda, ownerLabel, removeById, replaceById, toggleAgenda, toggleRequest,
} from './meeting-logic.ts';
import '../styles/docs-people.css';

const mark = (it: Pick<AgendaItem, 'status'>) => (it.status === 'open' ? '☐' : it.status === 'done' ? '☑' : '–');
const actionMark = (a: Pick<Action, 'status'>) => (a.status === 'done' ? '☑' : '☐');

export default function MeetingDoc() {
  const id = route.value.params['id'] ?? '';
  const [view, setView] = useState<MeetingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState<'me' | 'them'>('me');
  const alive = useRef(true);
  const pending = useRef(new Set<string>());
  usePanelTitle(view ? `1-1 · ${view.person.name}` : '1-1');

  const load = async (): Promise<void> => {
    const e = epoch();
    try {
      const d = await api.get<MeetingDetail>(`/api/meetings/${id}`);
      // Grouping needs the project names: wait for them when the store has not loaded yet.
      if (projects.peek().length === 0) await refreshProjects();
      if (!alive.current || e !== epoch()) return;
      setView(buildView(d));
      setError(null);
    } catch (err) {
      if (!alive.current || e !== epoch()) return;
      setError(err instanceof ApiError && err.status === 404 ? 'No such meeting.' : errorText(err));
    }
  };
  // Loading is a read; nothing is created or changed just because this route opened.
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [id]);

  /** Runs a write; results are applied only if this document and session are still the ones that asked. */
  const write = async <T,>(key: string, req: () => Promise<T>, apply: (r: T) => void, rollback?: () => void): Promise<void> => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const e = epoch();
    try {
      const r = await req();
      if (alive.current && e === epoch()) apply(r);
    } catch (err) {
      if (alive.current && e === epoch()) {
        rollback?.();
        flash(errorText(err), 'error');
      }
    } finally {
      pending.current.delete(key);
    }
  };

  if (!view) {
    return error
      ? (
        <div class="doc-section">
          <p class="error-text" role="alert">{error}</p>
          <button type="button" class="btn doc-more" onClick={() => { void load(); }}>Retry</button>
        </div>
      )
      : <p class="muted">Loading…</p>;
  }

  const { meeting, person, previous, active } = view;
  const meetingId = meeting.id;
  const personId = person.id;
  const patchView = (fn: (v: MeetingView) => MeetingView) => setView((v) => (v ? fn(v) : v));

  const toggleItem = async (item: AgendaItem): Promise<void> => {
    // The in-flight guard comes before the optimistic change, so a fast second press changes nothing.
    if (!active || pending.current.has(`agenda:${item.id}`)) return;
    patchView((v) => ({ ...v, agenda: toggleAgenda(v.agenda, item.id, meetingId, new Date().toISOString()) }));
    await write(
      `agenda:${item.id}`,
      () => api.patch<AgendaItem>(`/api/agenda/${item.id}`, toggleRequest(item, meetingId)),
      (next) => patchView((v) => ({ ...v, agenda: replaceById(v.agenda, next) })),
      () => patchView((v) => ({ ...v, agenda: replaceById(v.agenda, item) })),
    );
  };

  const deleteItem = (item: AgendaItem) =>
    active ? write(`agenda:${item.id}`, () => api.del(`/api/agenda/${item.id}`), () => patchView((v) => ({ ...v, agenda: removeById(v.agenda, item.id) }))) : undefined;

  const addAgenda = async (text: string): Promise<void> => {
    const e = epoch();
    try {
      const item = await api.post<AgendaItem>(`/api/people/${personId}/agenda`, { text });
      if (alive.current && e === epoch()) patchView((v) => ({ ...v, agenda: mergeAgenda(v.agenda, [item]) }));
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // the add field keeps the text
    }
  };

  const addFollowUp = async (text: string): Promise<void> => {
    const e = epoch();
    try {
      const a = await api.post<Action>('/api/actions', { text, owner, personId, meetingId });
      if (alive.current && e === epoch()) patchView((v) => ({ ...v, here: replaceById(v.here, a) }));
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err;
    }
  };

  const toggleAction = (a: Action, earlier: boolean) => {
    if (!active) return;
    const status = a.status === 'done' ? 'open' : 'done';
    return write(
      `action:${a.id}`,
      () => api.patch<Action>(`/api/actions/${a.id}`, { status }),
      (next) => patchView((v) => (earlier ? { ...v, earlier: replaceById(v.earlier, next) } : { ...v, here: replaceById(v.here, next) })),
    );
  };

  const deleteAction = (a: Action) =>
    active
      ? write(
        `action:${a.id}`,
        () => api.del(`/api/actions/${a.id}`),
        () => patchView((v) => ({ ...v, here: removeById(v.here, a.id), earlier: removeById(v.earlier, a.id) })),
      )
      : undefined;

  const end = async () => {
    if (!active) return;
    await write(
      'end',
      () => api.post<Meeting>(`/api/meetings/${meetingId}/end`),
      () => flash('Meeting ended'),
    );
    // Reload the ended meeting: it renders read-only from what the server really holds (incl. saved notes).
    if (alive.current) await load();
  };

  // Add fields exist only while the meeting is active.
  const agendaAdd: ListAdd = active ? { draftId: `person:${personId}:agenda`, addPlaceholder: 'Add an agenda item…', onAdd: addAgenda } : {};
  const followUpAdd: ListAdd = active
    ? { draftId: `meeting:${meetingId}:followups`, addPlaceholder: `Add a follow-up for ${owner === 'me' ? 'me' : person.name}…`, onAdd: addFollowUp }
    : {};
  // Projects without actions are left out by the helper; an empty "No project" group is hidden here.
  const groups = groupActionsByProject(view.earlier, projects.value).filter((g) => g.actions.length > 0);

  return (
    <div class="doc-people">
      <header class="doc-head">
        <div class="doc-meta">
          <button type="button" class="chip" onClick={() => openDoc({ kind: 'person', id: personId })}>{person.name}</button>
          <span class={active ? 'doc-badge' : undefined}>{active ? 'In progress' : 'Ended'}</span>
          <span>{`started ${formatWhen(meeting.startedAt)}`}</span>
          {meeting.endedAt && <span>{`ended ${formatWhen(meeting.endedAt)}`}</span>}
        </div>
        {active
          ? (
            <div class="doc-head-bar">
              <button
                type="button" class="btn"
                onClick={() => askConfirm('End this 1-1? Unchecked agenda items carry over to the next 1-1.', () => { void end(); })}
              >End meeting</button>
            </div>
          )
          : <p class="hint">This 1-1 has ended and is read-only.</p>}
      </header>

      <section class="doc-section" aria-label="Agenda">
        <h3>{`Agenda ${agendaProgress(view.agenda)}`}</h3>
        <List
          label="Agenda"
          items={view.agenda}
          empty={active ? 'No agenda items.' : 'Nothing was resolved in this meeting.'}
          {...agendaAdd}
          render={(it) => (
            <span class={it.status === 'open' ? undefined : 'row-done'}>
              <span class="check-mark" aria-hidden="true">{mark(it)}</span>
              <span class="sr-only">{it.status === 'open' ? 'Open: ' : 'Checked: '}</span>
              {it.text}
            </span>
          )}
          actions={(it) => active
            ? [
              { id: 'toggle', label: it.status === 'open' ? 'Check' : 'Uncheck', run: () => toggleItem(it) },
              { id: 'delete', label: 'Delete', danger: true, run: () => deleteItem(it) },
            ]
            : []}
        />
      </section>

      <section class="doc-section" aria-label="Follow-ups">
        <h3>Follow-ups</h3>
        {active && (
          <div class="owner-toggle" role="group" aria-label="Follow-up for">
            <span class="hint">New follow-up for</span>
            <button type="button" class="btn" aria-pressed={owner === 'me'} onClick={() => setOwner('me')}>Me</button>
            <button type="button" class="btn" aria-pressed={owner === 'them'} onClick={() => setOwner('them')}>Them</button>
          </div>
        )}
        <List
          label="Follow-ups"
          items={view.here}
          empty={active ? 'No follow-ups yet.' : 'No follow-ups from this meeting.'}
          {...followUpAdd}
          render={(a) => (
            <span class={a.status === 'done' ? 'row-done' : undefined}>
              <span class="check-mark" aria-hidden="true">{actionMark(a)}</span>
              <span class="owner-tag">{ownerLabel(a.owner)}</span>
              {a.text}
            </span>
          )}
          actions={(a) => active
            ? [
              { id: 'toggle', label: a.status === 'done' ? 'Reopen' : 'Done', run: () => toggleAction(a, false) },
              { id: 'delete', label: 'Delete', danger: true, run: () => deleteAction(a) },
            ]
            : []}
        />
      </section>

      {active && (
        <section class="doc-section" aria-label="Open actions">
          <h3>{`Open actions with ${person.name}`}</h3>
          {groups.length === 0 && <p class="empty">No other open actions.</p>}
          {groups.map((g) => (
            <div key={g.key} class="doc-section">
              <h4>{g.title}</h4>
              <List
                label={`Open actions: ${g.title}`}
                items={g.actions}
                render={(a) => (
                  <span class={a.status === 'done' ? 'row-done' : undefined}>
                    <span class="check-mark" aria-hidden="true">{actionMark(a)}</span>
                    <span class="owner-tag">{ownerLabel(a.owner)}</span>
                    {a.text}
                  </span>
                )}
                actions={(a) => [{ id: 'toggle', label: a.status === 'done' ? 'Reopen' : 'Done', run: () => toggleAction(a, true) }]}
              />
            </div>
          ))}
        </section>
      )}

      <section class="doc-section" aria-label="Notes">
        <h3>Notes</h3>
        {active
          ? (
            <TextEdit
              id={`meeting:${meetingId}:notes`} label="Meeting notes" multiline autosaveMs={3000}
              placeholder="Notes…"
              value={meeting.notesMd}
              onSave={(v) =>
                api.patch<Meeting>(`/api/meetings/${meetingId}`, { notesMd: v }).then((m) => {
                  if (alive.current) patchView((cur) => ({ ...cur, meeting: { ...cur.meeting, notesMd: m.notesMd } }));
                  return m;
                })}
            />
          )
          : <div class="doc-readonly">{meeting.notesMd.trim() === '' ? '(no notes)' : meeting.notesMd}</div>}
      </section>

      <section class="doc-section" aria-label="Previous 1-1">
        <h3>{previous ? `Previous 1-1 · ${formatWhen(previous.meeting.startedAt)}` : 'Previous 1-1'}</h3>
        {previous
          ? (
            <div class="doc-previous">
              <div class="doc-readonly">{previous.meeting.notesMd.trim() === '' ? '(no notes)' : previous.meeting.notesMd}</div>
              {previous.resolved.length > 0 && <h4>Resolved</h4>}
              {previous.resolved.length > 0 && (
                <ul>{previous.resolved.map((it) => <li key={it.id} class="doc-readonly">{`${mark(it)} ${it.text}`}</li>)}</ul>
              )}
              {previous.actions.length > 0 && <h4>Follow-ups</h4>}
              {previous.actions.length > 0 && (
                <ul>
                  {previous.actions.map((a) => (
                    <li key={a.id} class="doc-readonly">{`${actionMark(a)} (${ownerLabel(a.owner)}) ${oneLine(a.text, 500)}`}</li>
                  ))}
                </ul>
              )}
              <button
                type="button" class="btn doc-more"
                onClick={() => openDoc({ kind: 'meeting', id: previous.meeting.id })}
              >Open previous 1-1</button>
            </div>
          )
          : <p class="empty">No previous meeting.</p>}
      </section>
    </div>
  );
}
