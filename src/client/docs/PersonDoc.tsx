import { useEffect, useRef, useState } from 'preact/hooks';
import type { MeetingHeader, NoteSummary, PersonDetailResponse, UpdatePersonRequest } from '../../shared/api.ts';
import { LIMITS } from '../../shared/api.ts';
import type { Action, AgendaItem, Person } from '../../shared/types.ts';
import { List } from '../components/List.tsx';
import { PinButton } from '../components/PinButton.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { startMeeting } from '../lib/commands.ts';
import { appendPage, formatAliases, formatDay, formatWhen, mayHaveMore, oneLine, parseAliases } from '../lib/format.ts';
import { openDoc } from '../lib/nav.ts';
import { route } from '../lib/router.ts';
import { clearDraft, epoch, errorText, flash, projectTitle, refreshNav, refreshPeople, usePanelTitle } from '../lib/store.ts';
import { orderWithin } from './actions-logic.ts';
import { mergeAgenda, ownerLabel, removeById } from './meeting-logic.ts';
import '../styles/docs-people.css';

const PAGE = LIMITS.personNotes; // notes and meeting headers both page by 50

interface State {
  person: Person;
  agenda: AgendaItem[];
  actions: Action[];
  notes: NoteSummary[];
  meetings: MeetingHeader[];
  activeMeetingId: number | null;
  moreNotes: boolean;
  moreMeetings: boolean;
}

function fromDetail(d: PersonDetailResponse): State {
  return {
    person: d.person, agenda: d.openAgenda, actions: orderWithin(d.openActions), notes: d.notes, meetings: d.meetings,
    activeMeetingId: d.activeMeetingId, moreNotes: mayHaveMore(d.notes.length, PAGE), moreMeetings: mayHaveMore(d.meetings.length, PAGE),
  };
}

export default function PersonDoc() {
  const id = route.value.params['id'] ?? '';
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nameKey, setNameKey] = useState(0);
  const alive = useRef(true);
  const busy = useRef(new Set<string>());
  usePanelTitle(state ? `${state.person.name}${state.person.archivedAt ? ' (archived)' : ''}` : 'Person');

  const load = async (): Promise<void> => {
    const e = epoch();
    try {
      const d = await api.get<PersonDetailResponse>(`/api/people/${id}`);
      if (!alive.current || e !== epoch()) return;
      setState(fromDetail(d));
      setError(null);
    } catch (err) {
      if (!alive.current || e !== epoch()) return;
      setError(err instanceof ApiError && err.status === 404 ? 'No such person.' : errorText(err));
    }
  };
  // Loading is a read; nothing is started or changed just because this route opened.
  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [id]);

  const patch = (fn: (s: State) => State) => setState((s) => (s ? fn(s) : s));

  /** One write at a time per key; the result is applied only if this document and session are still current. */
  const write = async <T,>(key: string, req: () => Promise<T>, apply: (r: T) => void): Promise<void> => {
    if (busy.current.has(key)) return;
    busy.current.add(key);
    const e = epoch();
    try {
      const r = await req();
      if (alive.current && e === epoch()) apply(r);
    } catch (err) {
      if (alive.current && e === epoch()) flash(errorText(err), 'error');
    } finally {
      busy.current.delete(key);
    }
  };

  if (!state) {
    return error
      ? (
        <div class="doc-section">
          <p class="error-text" role="alert">{error}</p>
          <button type="button" class="btn doc-more" onClick={() => { void load(); }}>Retry</button>
        </div>
      )
      : <p class="muted">Loading…</p>;
  }

  const { person } = state;
  const personId = person.id;
  const resumable = state.activeMeetingId !== null;

  /** Offers an undo for a few seconds; it lapses with the session. */
  const offerUndo = (message: string, run: () => void) => {
    const e = epoch();
    flash(message, 'info', { action: { label: 'Undo', run: () => { if (e === epoch()) run(); } } });
  };

  const addAgenda = async (text: string): Promise<void> => {
    const e = epoch();
    try {
      const item = await api.post<AgendaItem>(`/api/people/${personId}/agenda`, { text });
      if (alive.current && e === epoch()) patch((s) => ({ ...s, agenda: mergeAgenda(s.agenda, [item]) }));
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // the add field keeps the text
    }
  };

  const resolveAgenda = (item: AgendaItem, status: 'done' | 'dropped') =>
    write(
      `agenda:${item.id}`,
      () => api.patch<AgendaItem>(`/api/agenda/${item.id}`, { status }),
      () => {
        patch((s) => ({ ...s, agenda: removeById(s.agenda, item.id) }));
        offerUndo(status === 'done' ? 'Agenda item done' : 'Agenda item dropped', () => {
          void write(
            `agenda:${item.id}`,
            () => api.patch<AgendaItem>(`/api/agenda/${item.id}`, { status: 'open' }),
            (back) => patch((s) => ({ ...s, agenda: mergeAgenda(s.agenda, [back]) })),
          );
        });
      },
    );

  const deleteAgenda = (item: AgendaItem) =>
    write(`agenda:${item.id}`, () => api.del(`/api/agenda/${item.id}`), () => patch((s) => ({ ...s, agenda: removeById(s.agenda, item.id) })));

  const completeAction = (a: Action) =>
    write(
      `action:${a.id}`,
      () => api.patch<Action>(`/api/actions/${a.id}`, { status: 'done' }),
      () => {
        patch((s) => ({ ...s, actions: removeById(s.actions, a.id) }));
        offerUndo('Action done', () => {
          void write(
            `action:${a.id}`,
            () => api.patch<Action>(`/api/actions/${a.id}`, { status: 'open' }),
            (back) => patch((s) => ({ ...s, actions: orderWithin([...s.actions, back]) })),
          );
        });
      },
    );

  const loadOlderNotes = () => {
    const last = state.notes[state.notes.length - 1];
    if (!last) return;
    void write(
      'more-notes',
      () => api.get<{ notes: NoteSummary[] }>(`/api/notes?personId=${personId}&before=${last.id}&limit=${PAGE}`),
      (r) => patch((s) => ({ ...s, notes: appendPage(s.notes, r.notes), moreNotes: mayHaveMore(r.notes.length, PAGE) })),
    );
  };

  const loadOlderMeetings = () => {
    const last = state.meetings[state.meetings.length - 1];
    if (!last) return;
    void write(
      'more-meetings',
      () => api.get<{ meetings: MeetingHeader[] }>(`/api/people/${personId}/meetings?before=${last.id}&limit=${PAGE}`),
      (r) => patch((s) => ({ ...s, meetings: appendPage(s.meetings, r.meetings), moreMeetings: mayHaveMore(r.meetings.length, PAGE) })),
    );
  };

  const savePerson = async (body: UpdatePersonRequest): Promise<Person> => {
    const p = await api.patch<Person>(`/api/people/${personId}`, body);
    if (alive.current) patch((s) => ({ ...s, person: p }));
    if ('name' in body || 'aliases' in body || 'archived' in body) void refreshPeople(); // pickers and the palette use the list; notes autosaves don't
    if ('name' in body || 'archived' in body) void refreshNav(); // Pinned and Recents show the name, the 1-1 titles and the archived flag
    return p;
  };

  const toggleArchive = () =>
    write('archive', () => savePerson({ archived: person.archivedAt === null }), (p) => flash(p.archivedAt ? 'Archived' : 'Restored'));

  const start = () => write('start', () => startMeeting(personId), () => undefined);

  return (
    <div class="doc-people">
      <header class="doc-head">
        <TextEdit
          key={nameKey} id={`person:${personId}:name`} label="Name" placeholder="Name"
          value={person.name}
          onSave={(v) => {
            if (v.trim() !== '') return savePerson({ name: v.trim() });
            // Blank is never saved: say so, drop the draft and show the stored name again.
            flash('Name cannot be empty', 'error');
            clearDraft(`person:${personId}:name`, v);
            setNameKey((k) => k + 1);
            return Promise.resolve();
          }}
        />
        <TextEdit
          id={`person:${personId}:aliases`} label="Aliases" placeholder="Aliases, comma separated"
          value={formatAliases(person.aliases)}
          onSave={(v) => savePerson({ aliases: parseAliases(v) })}
        />
        <div class="doc-head-bar">
          <button type="button" class="btn primary" onClick={start}>{resumable ? 'Resume 1-1' : 'Start 1-1'}</button>
          <PinButton kind="person" id={personId} />
          <span class="doc-spacer" />
          <button type="button" class="btn" onClick={toggleArchive}>{person.archivedAt === null ? 'Archive' : 'Restore'}</button>
        </div>
        {resumable && <div class="doc-meta"><span class="doc-badge">A 1-1 is in progress</span></div>}
      </header>

      <section class="doc-section" aria-label="Agenda">
        <h3>{`Agenda (${state.agenda.length})`}</h3>
        <List
          label="Agenda"
          items={state.agenda}
          empty="No open agenda items."
          draftId={`person:${personId}:agenda`}
          addPlaceholder="Add an agenda item…"
          onAdd={addAgenda}
          render={(it) => it.text}
          actions={(it) => [
            { id: 'done', label: 'Done', run: () => resolveAgenda(it, 'done') },
            { id: 'drop', label: 'Drop', run: () => resolveAgenda(it, 'dropped') },
            { id: 'delete', label: 'Delete', danger: true, run: () => deleteAgenda(it) },
          ]}
        />
      </section>

      <section class="doc-section" aria-label="Open actions">
        <h3>{`Open actions (mine ${state.actions.filter((a) => a.owner === 'me').length} / theirs ${state.actions.filter((a) => a.owner === 'them').length})`}</h3>
        <List
          label="Open actions"
          items={state.actions}
          empty="No open actions."
          render={(a) => {
            const project = projectTitle(a.projectId);
            return (
              <>
                <span class="owner-tag">{ownerLabel(a.owner)}</span>
                <span>{a.text}</span>
                {project !== null && <span class="muted">{`  · ${project}`}</span>}
              </>
            );
          }}
          actions={(a) => [{ id: 'done', label: 'Done', run: () => completeAction(a) }]}
        />
      </section>

      <section class="doc-section" aria-label="Notes">
        <h3>{`Notes (${state.notes.length}${state.moreNotes ? '+' : ''})`}</h3>
        <List
          label="Notes about this person"
          items={state.notes}
          empty="No notes about this person."
          render={(n) => (
            <>
              <span>{oneLine(n.title, 60)}</span>
              <span class="muted">{`  ${formatDay(n.createdAt)}`}</span>
            </>
          )}
          actions={(n) => [{ id: 'open', label: 'Open', run: () => openDoc({ kind: 'note', id: n.id }) }]}
        />
        {state.moreNotes && <button type="button" class="btn doc-more" onClick={loadOlderNotes}>Load older notes</button>}
      </section>

      <section class="doc-section" aria-label="Past meetings">
        <h3>{`Past meetings (${state.meetings.length}${state.moreMeetings ? '+' : ''})`}</h3>
        <List
          label="Meetings"
          items={state.meetings}
          empty="No meetings yet."
          render={(m) => (
            <>
              <span>{formatWhen(m.startedAt)}</span>
              <span class={m.endedAt === null ? 'doc-badge' : 'muted'}>{m.endedAt === null ? '  in progress' : '  ended'}</span>
              {m.preview !== '' && <span class="muted">{`  ${oneLine(m.preview, 60)}`}</span>}
            </>
          )}
          actions={(m) => [{ id: 'open', label: 'Open', run: () => openDoc({ kind: 'meeting', id: m.id }) }]}
        />
        {state.moreMeetings && <button type="button" class="btn doc-more" onClick={loadOlderMeetings}>Load older meetings</button>}
      </section>

      <section class="doc-section" aria-label="About this person">
        <h3>Notes about this person</h3>
        <TextEdit
          id={`person:${personId}:notes`} label="Person notes" multiline autosaveMs={3000}
          placeholder="Notes about this person…"
          value={person.notesMd}
          onSave={(v) => savePerson({ notesMd: v })}
        />
      </section>
    </div>
  );
}
