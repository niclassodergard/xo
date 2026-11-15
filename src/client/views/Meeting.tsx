import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, AgendaItem, Meeting as MeetingRecord, MeetingDetail } from '../../shared/types.ts';
import { Overlay } from '../components/Overlay.tsx';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { navigate, route } from '../lib/router.ts';
import { askText, epoch, errorText, flash } from '../lib/store.ts';
import type { ActionRow, MeetingView } from './meeting-logic.ts';
import {
  actionRows, agendaMark, agendaProgress, buildView, cyclePane, formatWhen, mergeAgenda, oneLine, removeById, replaceById,
  toggleAgenda, toggleRequest,
} from './meeting-logic.ts';

const AGENDA = 0, FOLLOWUPS = 1, NOTES = 2, PREVIOUS = 3;
const PANE_COUNT = 4;

function ConfirmEnd(props: { onYes: () => void; onNo: () => void }) {
  useKeys({ y: props.onYes, n: props.onNo, esc: props.onNo }, { scope: 'modal', modes: ['normal', 'insert', 'command'] });
  return (
    <Overlay label="End this 1-1" onBackdrop={props.onNo}>
      <Pane title="End this 1-1?" focused>
        <div>Unchecked agenda items carry over to the next 1-1.</div>
        <div class="prompt-line">
          <button type="button" class="tbtn" onClick={props.onNo}>Cancel (n)</button>
          <button type="button" class="tbtn" onClick={props.onYes}>End meeting (y)</button>
        </div>
      </Pane>
    </Overlay>
  );
}

function followUpText(row: ActionRow): string {
  const a = row.action;
  return `${a.status === 'done' ? '[x]' : '[ ]'} (${a.owner}) ${a.text}`;
}

export default function Meeting() {
  const id = route.value.params.id ?? '';
  const [view, setView] = useState<MeetingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pane, setPane] = useState(AGENDA);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const alive = useRef(true);
  const pending = useRef(new Set<string>());
  const notesBox = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);
  const paneEls = useRef<(HTMLDivElement | null)[]>([]);
  const firstPane = useRef(true);

  const load = async (): Promise<void> => {
    const e = epoch();
    try {
      const d = await api.get<MeetingDetail>(`/api/meetings/${id}`);
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

  // Keep the focused pane on screen (Tab with a long agenda would otherwise leave it below the fold).
  useEffect(() => {
    if (firstPane.current) { firstPane.current = false; return; }
    paneEls.current[pane]?.scrollIntoView?.({ block: 'nearest' });
  }, [pane]);

  /** Runs a write; results are applied only if this view and session are still the ones that asked. */
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

  const active = view?.active === true;
  const meetingId = view?.meeting.id ?? 0;
  const personId = view?.person.id ?? 0;
  const patchView = (fn: (v: MeetingView) => MeetingView) => setView((v) => (v ? fn(v) : v));

  const toggleItem = (item: AgendaItem) => {
    if (!active || pending.current.has(`agenda:${item.id}`)) return;
    patchView((v) => ({ ...v, agenda: toggleAgenda(v.agenda, item.id, meetingId, new Date().toISOString()) }));
    void write(
      `agenda:${item.id}`,
      () => api.patch<AgendaItem>(`/api/agenda/${item.id}`, toggleRequest(item, meetingId)),
      (next) => patchView((v) => ({ ...v, agenda: replaceById(v.agenda, next) })),
      () => patchView((v) => ({ ...v, agenda: replaceById(v.agenda, item) })),
    );
  };

  const deleteItem = (item: AgendaItem) => {
    if (!active) return;
    void write(`agenda:${item.id}`, () => api.del(`/api/agenda/${item.id}`), () => patchView((v) => ({ ...v, agenda: removeById(v.agenda, item.id) })));
  };

  const addAgenda = (text: string) => {
    void write(
      `add-agenda:${++seq.current}`,
      () => api.post<AgendaItem>(`/api/people/${personId}/agenda`, { text }),
      (item) => patchView((v) => ({ ...v, agenda: mergeAgenda(v.agenda, [item]) })),
    );
  };

  const addFollowUp = (owner: 'me' | 'them') => (text: string) => {
    void write(
      `add-action:${++seq.current}`,
      () => api.post<Action>('/api/actions', { text, owner, personId, meetingId }),
      (a) => patchView((v) => ({ ...v, here: replaceById(v.here, a) })),
    );
  };

  const toggleFollowUp = (row: ActionRow) => {
    if (!active) return;
    const status = row.action.status === 'done' ? 'open' : 'done';
    void write(
      `action:${row.action.id}`,
      () => api.patch<Action>(`/api/actions/${row.action.id}`, { status }),
      (a) => patchView((v) => (row.earlier ? { ...v, earlier: replaceById(v.earlier, a) } : { ...v, here: replaceById(v.here, a) })),
    );
  };

  const deleteFollowUp = (row: ActionRow) => {
    if (!active) return;
    void write(
      `action:${row.action.id}`,
      () => api.del(`/api/actions/${row.action.id}`),
      () => patchView((v) => ({ ...v, here: removeById(v.here, row.action.id), earlier: removeById(v.earlier, row.action.id) })),
    );
  };

  const end = async () => {
    setConfirmEnd(false);
    if (!active) return;
    await write(
      'end',
      () => api.post<MeetingRecord>(`/api/meetings/${meetingId}/end`),
      () => { flash('Meeting ended'); setPane(AGENDA); },
    );
    // Reload the ended meeting: it renders read-only from what the server really holds (incl. saved notes).
    if (alive.current) await load();
  };

  const focusNotes = () => {
    setPane(NOTES);
    notesBox.current?.querySelector('textarea')?.focus();
  };

  useKeys(
    {
      tab: () => setPane((p) => cyclePane(p, PANE_COUNT, 1)),
      'shift+tab': () => setPane((p) => cyclePane(p, PANE_COUNT, -1)),
      left: () => setPane((p) => cyclePane(p, PANE_COUNT, -1)),
      right: () => setPane((p) => cyclePane(p, PANE_COUNT, 1)),
      // Replace this entry (not push) so the next Esc leaves the person instead of coming back here.
      esc: () => navigate(`/people/${personId}`, { replace: true }),
      // Nothing in a meeting is undone with `u`; say so instead of doing nothing.
      u: () => flash('Nothing to undo here. x unchecks an item.'),
      ...(active
        ? {
            a: () => askText('Add agenda item', addAgenda),
            t: () => askText('Follow-up for me', addFollowUp('me')),
            'shift+t': () => askText('Follow-up for them', addFollowUp('them')),
            n: focusNotes,
            'shift+e': () => setConfirmEnd(true),
          }
        : {}),
    },
    {
      enabled: view !== null && !confirmEnd,
      descriptions: {
        tab: 'next pane', 'shift+tab': 'previous pane', right: 'next pane', left: 'previous pane', esc: 'back to the person', u: 'no undo here (x unchecks)',
        a: 'add agenda item', t: 'add follow-up (me)', 'shift+t': 'add follow-up (them)', n: 'edit notes', 'shift+e': 'end meeting',
      },
    },
  );
  useKeys({ r: () => { void load(); } }, { enabled: view === null && error !== null });
  // While loading or after an error ←/→ do nothing here, rather than switching the view.
  useKeys({ left: () => undefined, right: () => undefined }, { enabled: view === null });

  if (!view) {
    return <Pane title="1-1">{error ? <div>{error}<div class="hint">r to retry, Esc to go back</div></div> : <div class="dim">Loading…</div>}</Pane>;
  }

  const { meeting, person, previous } = view;
  const rows = actionRows(view.here, view.earlier);
  const hint = active
    ? 'j/k move · x check · a add item · t/T follow-up (me/them) · d d delete · n notes · Tab pane · E end · Esc person'
    : 'This 1-1 has ended and is read-only · Esc back to the person';

  return (
    <>
      <Pane title={`1-1 · ${person.name}`}>
        <div>
          {active ? 'In progress' : 'Ended'} · started {formatWhen(meeting.startedAt)}
          {meeting.endedAt ? ` · ended ${formatWhen(meeting.endedAt)}` : ''}
        </div>
        <div class="hint">{hint}</div>
      </Pane>

      <div onClick={() => setPane(AGENDA)} ref={(el) => { paneEls.current[AGENDA] = el; }}>
        <Pane title={`Agenda ${agendaProgress(view.agenda)}`} focused={pane === AGENDA}>
          <SelectableList
            items={view.agenda}
            enabled={pane === AGENDA}
            empty={active ? 'No agenda items. Press a to add one.' : 'Nothing was resolved in this meeting.'}
            onOpen={active ? toggleItem : undefined}
            keyDescriptions={{ x: 'check / uncheck agenda item', 'd d': 'delete agenda item' }}
            keys={active ? { x: toggleItem, 'd d': deleteItem } : undefined}
            render={(it) => <span class={it.status === 'open' ? '' : 'dim'}>{`${agendaMark(it)} ${it.text}`}</span>}
          />
        </Pane>
      </div>

      <div onClick={() => setPane(FOLLOWUPS)} ref={(el) => { paneEls.current[FOLLOWUPS] = el; }}>
        <Pane title="Follow-ups" focused={pane === FOLLOWUPS}>
          <SelectableList
            items={rows.map((r) => ({ ...r, id: r.action.id }))}
            enabled={pane === FOLLOWUPS}
            empty={active ? 'No follow-ups yet. t = for me, T = for them.' : 'No follow-ups from this meeting.'}
            keyDescriptions={{ x: 'toggle follow-up done', 'd d': 'delete follow-up' }}
            keys={active ? { x: toggleFollowUp, 'd d': deleteFollowUp } : undefined}
            render={(r) => (
              <span class={r.action.status === 'done' ? 'dim' : ''}>
                {followUpText(r)}
                {r.earlier && <span class="dim">{'  (earlier)'}</span>}
              </span>
            )}
          />
        </Pane>
      </div>

      <div onClick={() => setPane(NOTES)} ref={(el) => { notesBox.current = el; paneEls.current[NOTES] = el; }}>
        <Pane title="Notes" focused={pane === NOTES}>
          {active ? (
            <TextEdit
              id={`meeting:${meeting.id}:notes`}
              label="Meeting notes"
              multiline
              autosaveMs={3000}
              placeholder="Notes… (n to focus, Esc to save and leave)"
              value={meeting.notesMd}
              onSave={(v) =>
                api.patch<MeetingRecord>(`/api/meetings/${meeting.id}`, { notesMd: v }).then((m) => {
                  if (alive.current) patchView((cur) => ({ ...cur, meeting: { ...cur.meeting, notesMd: m.notesMd } }));
                  return m;
                })}
            />
          ) : (
            <div class="row-body">{meeting.notesMd.trim() === '' ? '(no notes)' : meeting.notesMd}</div>
          )}
        </Pane>
      </div>

      <div onClick={() => setPane(PREVIOUS)} ref={(el) => { paneEls.current[PREVIOUS] = el; }}>
        <Pane title={previous ? `Previous 1-1 · ${formatWhen(previous.meeting.startedAt)}` : 'Previous 1-1'} focused={pane === PREVIOUS}>
          {previous ? (
            <>
              <div class="row-body">{previous.meeting.notesMd.trim() === '' ? '(no notes)' : previous.meeting.notesMd}</div>
              {previous.resolved.length > 0 && <div class="dim">Resolved</div>}
              {previous.resolved.map((it) => <div key={it.id} class="row-body">{`${agendaMark(it)} ${it.text}`}</div>)}
              {previous.actions.length > 0 && <div class="dim">Follow-ups</div>}
              {previous.actions.map((a) => (
                <div key={a.id} class="row-body">{`${a.status === 'done' ? '[x]' : '[ ]'} (${a.owner}) ${oneLine(a.text, 500)}`}</div>
              ))}
            </>
          ) : (
            <div class="empty">No previous meeting.</div>
          )}
        </Pane>
      </div>
      {confirmEnd && <ConfirmEnd onYes={() => { void end(); }} onNo={() => setConfirmEnd(false)} />}
    </>
  );
}
