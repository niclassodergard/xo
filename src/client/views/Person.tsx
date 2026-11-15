import { useEffect, useRef, useState } from 'preact/hooks';
import type { MeetingHeader, NoteSummary, PersonDetailResponse, UpdatePersonRequest } from '../../shared/api.ts';
import { LIMITS } from '../../shared/api.ts';
import type { Action, AgendaItem, MeetingDetail, Person as PersonRecord } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { navigate, route } from '../lib/router.ts';
import { askText, clearDraft, epoch, errorText, flash, refreshPeople } from '../lib/store.ts';
import {
  agendaMark, appendPage, cyclePane, formatAliases, formatDay, formatWhen, mayHaveMore, mergeAgenda, oneLine, parseAliases, removeById,
  splitByOwner,
} from './meeting-logic.ts';

const AGENDA = 0, ACTIONS = 1, NOTES = 2, MEETINGS = 3, ABOUT = 4;
const PANE_COUNT = 5;
const PAGE = LIMITS.personNotes; // notes and meeting headers both page by 50

interface State {
  person: PersonRecord;
  agenda: AgendaItem[];
  actions: Action[];
  notes: NoteSummary[];
  meetings: MeetingHeader[];
  activeMeetingId: number | null;
  moreNotes: boolean;
  moreMeetings: boolean;
}

function fromDetail(d: PersonDetailResponse): State {
  const { mine, theirs } = splitByOwner(d.openActions);
  return {
    person: d.person, agenda: d.openAgenda, actions: [...mine, ...theirs], notes: d.notes, meetings: d.meetings,
    activeMeetingId: d.activeMeetingId, moreNotes: mayHaveMore(d.notes.length, PAGE), moreMeetings: mayHaveMore(d.meetings.length, PAGE),
  };
}

const UNDO_WINDOW_MS = 6000;

export default function Person() {
  const id = route.value.params.id ?? '';
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState(AGENDA);
  const alive = useRef(true);
  const busy = useRef(new Set<string>());
  const nameBox = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const undoOffer = useRef<{ run: () => void; until: number } | null>(null);
  const paneEls = useRef<(HTMLDivElement | null)[]>([]);
  const firstPane = useRef(true);
  const [nameKey, setNameKey] = useState(0);
  const aboutBox = useRef<HTMLDivElement | null>(null);

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

  // Keep the focused pane on screen (Tab with a long agenda would otherwise leave it below the fold).
  useEffect(() => {
    if (firstPane.current) { firstPane.current = false; return; }
    paneEls.current[pane]?.scrollIntoView?.({ block: 'nearest' });
  }, [pane]);

  const patch = (fn: (s: State) => State) => setState((s) => (s ? fn(s) : s));

  /** One write at a time per key; the result is applied only if this view and session are still current. */
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

  const personId = state?.person.id ?? 0;

  // Start a new 1-1, or resume the active one (the server returns it). Always an explicit key press.
  const start = () => {
    void write(
      'start',
      () => api.post<MeetingDetail>(`/api/people/${personId}/meetings`),
      (m) => navigate(`/meetings/${m.meeting.id}`, { replace: true }),
    );
  };

  const addAgenda = (text: string) => {
    void write(
      `add-agenda:${++seq.current}`,
      () => api.post<AgendaItem>(`/api/people/${personId}/agenda`, { text }),
      (item) => patch((s) => ({ ...s, agenda: mergeAgenda(s.agenda, [item]) })),
    );
  };

  /** The one live undo offer of this view; `u` runs it. It lapses with the session and after a few seconds. */
  const offerUndo = (message: string, run: () => void) => {
    const e = epoch();
    const act = () => { if (e === epoch()) run(); };
    undoOffer.current = { run: act, until: Date.now() + UNDO_WINDOW_MS };
    flash(`${message} - u to undo`, 'info', { action: { label: 'undo', run: () => { undoOffer.current = null; act(); } } });
  };
  // View-scope `u`: only ever undoes this view's own offer, never the global "undo last chat capture".
  const undo = () => {
    const o = undoOffer.current;
    undoOffer.current = null;
    if (o && Date.now() <= o.until) o.run();
    else flash('Nothing to undo here');
  };

  /** Resolve an agenda item outside a meeting; the flash offers an undo that puts it back. */
  const resolveAgenda = (item: AgendaItem, status: 'done' | 'dropped') => {
    void write(
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
  };

  const deleteAgenda = (item: AgendaItem) => {
    void write(`agenda:${item.id}`, () => api.del(`/api/agenda/${item.id}`), () => patch((s) => ({ ...s, agenda: removeById(s.agenda, item.id) })));
  };

  const completeAction = (a: Action) => {
    void write(
      `action:${a.id}`,
      () => api.patch<Action>(`/api/actions/${a.id}`, { status: 'done' }),
      () => {
        patch((s) => ({ ...s, actions: removeById(s.actions, a.id) }));
        offerUndo('Action done', () => {
          void write(
            `action:${a.id}`,
            () => api.patch<Action>(`/api/actions/${a.id}`, { status: 'open' }),
            (back) => patch((s) => {
              const { mine, theirs } = splitByOwner([...s.actions, back]);
              return { ...s, actions: [...mine, ...theirs] };
            }),
          );
        });
      },
    );
  };

  const loadOlderNotes = () => {
    if (!state?.moreNotes) { flash('No older notes'); return; }
    const last = state.notes[state.notes.length - 1];
    if (!last) return;
    void write(
      'more-notes',
      () => api.get<{ notes: NoteSummary[] }>(`/api/notes?personId=${personId}&before=${last.id}&limit=${PAGE}`),
      (r) => patch((s) => ({ ...s, notes: appendPage(s.notes, r.notes), moreNotes: mayHaveMore(r.notes.length, PAGE) })),
    );
  };

  const loadOlderMeetings = () => {
    if (!state?.moreMeetings) { flash('No older meetings'); return; }
    const last = state.meetings[state.meetings.length - 1];
    if (!last) return;
    void write(
      'more-meetings',
      () => api.get<{ meetings: MeetingHeader[] }>(`/api/people/${personId}/meetings?before=${last.id}&limit=${PAGE}`),
      (r) => patch((s) => ({ ...s, meetings: appendPage(s.meetings, r.meetings), moreMeetings: mayHaveMore(r.meetings.length, PAGE) })),
    );
  };

  const savePerson = async (body: UpdatePersonRequest): Promise<PersonRecord> => {
    const p = await api.patch<PersonRecord>(`/api/people/${personId}`, body);
    if (alive.current) patch((s) => ({ ...s, person: p }));
    if ('name' in body || 'aliases' in body) void refreshPeople(); // the picker/palette lists need it; notes autosaves don't
    return p;
  };

  const focusIn = (box: HTMLDivElement | null, selector: string) => { box?.querySelector<HTMLElement>(selector)?.focus(); };

  useKeys(
    {
      tab: () => setPane((p) => cyclePane(p, PANE_COUNT, 1)),
      'shift+tab': () => setPane((p) => cyclePane(p, PANE_COUNT, -1)),
      a: () => askText('Add agenda item', addAgenda),
      s: start,
      u: undo,
      e: () => focusIn(nameBox.current, 'input'),
      n: () => { setPane(ABOUT); focusIn(aboutBox.current, 'textarea'); },
      m: () => { if (pane === NOTES) loadOlderNotes(); else if (pane === MEETINGS) loadOlderMeetings(); },
    },
    {
      enabled: state !== null,
      descriptions: {
        tab: 'next pane', 'shift+tab': 'previous pane', a: 'add agenda item', s: 'start or resume 1-1', u: 'undo the last done/drop here',
        e: 'edit name and aliases', n: 'edit person notes', m: 'load older notes/meetings',
      },
    },
  );
  useKeys({ r: () => { void load(); } }, { enabled: state === null && error !== null });

  if (!state) {
    return <Pane title="Person">{error ? <div>{error}<div class="hint">r to retry, Esc to go back</div></div> : <div class="dim">Loading…</div>}</Pane>;
  }

  const { person } = state;
  const resumable = state.activeMeetingId !== null;
  const { mine, theirs } = splitByOwner(state.actions);

  return (
    <>
      <Pane title={`${person.name}${person.archivedAt ? ' (archived)' : ''}`}>
        <div ref={nameBox}>
          <TextEdit
            key={nameKey} id={`person:${person.id}:name`} label="Name" placeholder="Name"
            value={person.name}
            onSave={(v) => {
              if (v.trim() !== '') return savePerson({ name: v.trim() });
              // Blank is never saved: say so, drop the draft and show the stored name again.
              flash('Name cannot be empty', 'error');
              clearDraft(`person:${person.id}:name`, v);
              setNameKey((k) => k + 1);
              return Promise.resolve();
            }}
          />
          <TextEdit
            id={`person:${person.id}:aliases`} label="Aliases" placeholder="Aliases, comma separated"
            value={formatAliases(person.aliases)}
            onSave={(v) => savePerson({ aliases: parseAliases(v) })}
          />
        </div>
        <div class="hint">
          {resumable ? 'A 1-1 is in progress: s resumes it' : 's start 1-1'} · a add agenda · e edit name · n notes · Tab pane · m older
        </div>
      </Pane>

      <div onClick={() => setPane(AGENDA)} ref={(el) => { paneEls.current[AGENDA] = el; }}>
        <Pane title={`Agenda (${state.agenda.length})`} focused={pane === AGENDA}>
          <SelectableList
            items={state.agenda}
            enabled={pane === AGENDA}
            empty="No open agenda items. Press a to add one."
            keyDescriptions={{ x: 'agenda item done', 'shift+x': 'drop agenda item', 'd d': 'delete agenda item' }}
            keys={{ x: (it) => resolveAgenda(it, 'done'), 'shift+x': (it) => resolveAgenda(it, 'dropped'), 'd d': deleteAgenda }}
            render={(it) => `${agendaMark(it)} ${it.text}`}
          />
          {state.agenda.length > 0 && <div class="hint">x done · X drop · d d delete</div>}
        </Pane>
      </div>

      <div onClick={() => setPane(ACTIONS)} ref={(el) => { paneEls.current[ACTIONS] = el; }}>
        <Pane title={`Open actions (mine ${mine.length} / theirs ${theirs.length})`} focused={pane === ACTIONS}>
          <SelectableList
            items={state.actions}
            enabled={pane === ACTIONS}
            empty="No open actions."
            keyDescriptions={{ x: 'complete action' }}
            keys={{ x: completeAction }}
            render={(a) => `[ ] (${a.owner}) ${a.text}`}
          />
          {state.actions.length > 0 && <div class="hint">x mark done</div>}
        </Pane>
      </div>

      <div onClick={() => setPane(NOTES)} ref={(el) => { paneEls.current[NOTES] = el; }}>
        <Pane title={`Notes (${state.notes.length}${state.moreNotes ? '+' : ''})`} focused={pane === NOTES}>
          <SelectableList
            items={state.notes}
            enabled={pane === NOTES}
            empty="No notes about this person."
            onOpen={(n) => navigate(`/notes/${n.id}`)}
            render={(n) => (
              <>
                <span>{oneLine(n.title, 60)}</span>
                <span class="dim">{`  ${formatDay(n.createdAt)}`}</span>
              </>
            )}
          />
        </Pane>
      </div>

      <div onClick={() => setPane(MEETINGS)} ref={(el) => { paneEls.current[MEETINGS] = el; }}>
        <Pane title={`Past meetings (${state.meetings.length}${state.moreMeetings ? '+' : ''})`} focused={pane === MEETINGS}>
          <SelectableList
            items={state.meetings}
            enabled={pane === MEETINGS}
            empty="No meetings yet. Press s to start a 1-1."
            onOpen={(m) => navigate(`/meetings/${m.id}`, { replace: true })}
            render={(m) => (
              <>
                <span>{formatWhen(m.startedAt)}</span>
                <span class={m.endedAt === null ? 'accent' : 'dim'}>{m.endedAt === null ? '  in progress' : '  ended'}</span>
                {m.preview !== '' && <span class="dim">{`  ${oneLine(m.preview, 60)}`}</span>}
              </>
            )}
          />
        </Pane>
      </div>

      <div onClick={() => setPane(ABOUT)} ref={(el) => { aboutBox.current = el; paneEls.current[ABOUT] = el; }}>
        <Pane title="Notes about this person" focused={pane === ABOUT}>
          <TextEdit
            id={`person:${person.id}:notes`} label="Person notes" multiline autosaveMs={3000}
            placeholder="Notes about this person… (n to focus, Esc to save and leave)"
            value={person.notesMd}
            onSave={(v) => savePerson({ notesMd: v })}
          />
        </Pane>
      </div>
    </>
  );
}
