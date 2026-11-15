import { useEffect, useRef, useState } from 'preact/hooks';
import type { Action, Person, Project } from '../../shared/types.ts';
import type { NoteSummary, ProjectDetailResponse } from '../../shared/api.ts';
import { ItemPicker } from '../components/ItemPicker.tsx';
import { List } from '../components/List.tsx';
import { PinButton } from '../components/PinButton.tsx';
import { TextEdit } from '../components/TextEdit.tsx';
import { api } from '../lib/api.ts';
import { formatAliases, oneLine, parseAliases } from '../lib/format.ts';
import { openDoc } from '../lib/nav.ts';
import type { RowAction } from '../lib/row-actions.ts';
import { navigate, route } from '../lib/router.ts';
import {
  askConfirm, askPick, clearDraft, epoch, errorText, flash, people, personName, refreshNav, refreshProjects, usePanelTitle,
} from '../lib/store.ts';
import { EditActionDialog } from './EditActionDialog.tsx';
import { actionRowActions, orderWithin, toggledStatus } from './actions-logic.ts';
import type { ActionRowHandlers } from './actions-logic.ts';
import { addPerson, isStatus, removePerson, sameAliases, STATUS_LABEL, STATUS_ORDER } from './project-logic.ts';
import '../styles/docs-projects.css';

/** One project: title, status, aliases, pin, description, people, actions (open and done), notes, delete. */
export default function ProjectDoc() {
  const id = Number(route.value.params['id']);
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [titleKey, setTitleKey] = useState(0);
  const [showDone, setShowDone] = useState(false);
  const [editing, setEditing] = useState<Action | null>(null);
  const [personFor, setPersonFor] = useState<number | null>(null); // action whose person is being picked
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  usePanelTitle(detail?.project.title ?? 'Project');

  const load = async (): Promise<void> => {
    const e = epoch();
    const mine = ++seq.current;
    try {
      const d = await api.get<ProjectDetailResponse>(`/api/projects/${id}`);
      if (e === epoch() && mine === seq.current && alive.current) { setDetail(d); setMissing(false); setLoadError(null); }
    } catch (err) {
      if (e !== epoch() || mine !== seq.current || !alive.current) return;
      if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) setMissing(true);
      else setLoadError(errorText(err));
    }
  };
  useEffect(() => { void load(); }, [id]);

  // Runs a write, then reloads the detail and the project list (open counts) unless the session changed.
  const write = async (fn: () => Promise<unknown>): Promise<void> => {
    const e = epoch();
    await fn();
    if (e !== epoch()) return;
    await Promise.all([load(), refreshProjects()]);
  };
  // For add fields: report a failure ourselves (the List keeps the typed text when this rejects).
  const adder = (fn: (text: string) => Promise<unknown>) => async (text: string): Promise<void> => {
    const e = epoch();
    try { await write(() => fn(text)); } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err;
    }
  };

  const patchProject = async (body: Record<string, unknown>, lists = true): Promise<void> => {
    const e = epoch();
    const p = await api.patch<Project>(`/api/projects/${id}`, body);
    if (e !== epoch() || !alive.current) return;
    setDetail((d) => (d ? { ...d, project: p } : d));
    if (lists) { void refreshProjects(); void refreshNav(); }
  };

  if (missing) return <p class="muted">This project no longer exists.</p>;
  if (!detail) {
    return loadError !== null ? (
      <div>
        <p class="error-text">{`Could not load the project: ${loadError}`}</p>
        <button type="button" class="btn" onClick={() => { setLoadError(null); void load(); }}>Retry</button>
      </div>
    ) : <p class="muted">Loading…</p>;
  }
  const { project } = detail;

  const patchAction = (a: Action, body: Record<string, unknown>) => write(() => api.patch(`/api/actions/${a.id}`, body));
  const handlers: ActionRowHandlers = {
    toggle: (a) => patchAction(a, { status: toggledStatus(a) }),
    edit: (a) => setEditing(a),
    pickProject: () => undefined, // unused: the document is the project
    pickPerson: (a) => setPersonFor(a.id),
    toggleOwner: (a) => patchAction(a, { owner: a.owner === 'me' ? 'them' : 'me' }),
    remove: (a) => write(() => api.del(`/api/actions/${a.id}`)),
  };
  const rowActions = (a: Action): RowAction[] => actionRowActions(a, handlers, { withProject: false });
  const renderAction = (a: Action, done: boolean) => (
    <>
      <span class={done ? 'proj-done-text' : undefined}>{a.text}</span>
      {a.owner === 'them' && <span class="proj-tag">them</span>}
      {personName(a.personId) && <span class="proj-tag">{personName(a.personId)}</span>}
    </>
  );

  const addLinkedPerson = (personId: number) => {
    const e = epoch();
    void api.put(`/api/projects/${id}/people/${personId}`).then(() => {
      if (e !== epoch() || !alive.current) return undefined;
      const p = people.peek().find((x) => x.id === personId);
      if (p) setDetail((d) => (d ? { ...d, people: addPerson(d.people, p) } : d));
      else return load();
      return undefined;
    }).catch((err: unknown) => { if (e === epoch()) flash(errorText(err), 'error'); });
  };
  const unlinkPerson = async (p: Person): Promise<void> => {
    const e = epoch();
    await api.del(`/api/projects/${id}/people/${p.id}`);
    if (e === epoch() && alive.current) setDetail((d) => (d ? { ...d, people: removePerson(d.people, p.id) } : d));
  };

  const deleteProject = () => {
    askConfirm(
      `Delete project “${oneLine(project.title, 60)}”? Its actions and notes are kept, but they lose the project and show under No project.`,
      () => {
        const e = epoch();
        void api.del(`/api/projects/${id}`).then(async () => {
          if (e !== epoch()) return;
          await Promise.all([refreshProjects(), refreshNav()]);
          if (e === epoch()) navigate('/projects', { replace: true });
        }).catch((err: unknown) => { if (e === epoch()) flash(errorText(err), 'error'); });
      },
    );
  };

  return (
    <div class="project-doc">
      <div class="project-head">
        <div class="project-title-edit">
          <TextEdit
            key={titleKey} id={`project:${id}:title`} label="Project title" value={project.title}
            onSave={async (v) => {
              const t = v.trim();
              if (!t) {
                // Blank is never saved: say so, drop the draft and show the stored title again.
                flash('Title cannot be empty', 'error');
                clearDraft(`project:${id}:title`, v);
                setTitleKey((k) => k + 1);
                return;
              }
              if (t !== project.title) await patchProject({ title: t });
            }}
          />
        </div>
        <div class="project-meta">
          <label>
            Status
            <select
              class="project-select" aria-label="Status" value={project.status}
              onChange={(ev) => {
                const v = (ev.target as HTMLSelectElement).value;
                if (!isStatus(v)) return;
                void patchProject({ status: v }).catch((err: unknown) => { flash(errorText(err), 'error'); void load(); });
              }}
            >
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <PinButton kind="project" id={id} />
        </div>
        <div class="project-aliases">
          <TextEdit
            id={`project:${id}:aliases`} label="Aliases (comma separated)" placeholder="Aliases, comma separated"
            value={formatAliases(project.aliases)}
            onSave={async (v) => {
              const next = parseAliases(v);
              if (!sameAliases(next, project.aliases)) await patchProject({ aliases: next });
            }}
          />
        </div>
      </div>

      <section class="project-section" aria-label="Description">
        <h3 class="project-section-title">Description</h3>
        <TextEdit
          id={`project:${id}:description`} label="Description" placeholder="What is this project about?" multiline autosaveMs={800}
          value={project.descriptionMd}
          onSave={async (v) => { if (v !== project.descriptionMd) await patchProject({ descriptionMd: v }, false); }}
        />
      </section>

      <section class="project-section" aria-label="People">
        <h3 class="project-section-title">People</h3>
        <List
          items={detail.people} label="People on this project" empty="No people linked yet."
          render={(p: Person) => <span>{p.name}</span>}
          actions={(p: Person) => [
            { id: 'open', label: 'Open', run: () => openDoc({ kind: 'person', id: p.id }) },
            { id: 'remove', label: 'Remove', run: () => unlinkPerson(p) },
          ]}
        />
        <button type="button" class="btn project-toggle" onClick={() => askPick('person', addLinkedPerson)}>Add person</button>
      </section>

      <section class="project-section" aria-label="Actions">
        <h3 class="project-section-title">Actions</h3>
        <List
          items={orderWithin(detail.openActions)} label="Open actions" empty="No open actions."
          render={(a: Action) => renderAction(a, false)} actions={rowActions}
          onAdd={adder((text) => api.post('/api/actions', { text, projectId: id }))} draftId={`project:${id}:actions`}
          addPlaceholder="Add an action…"
        />
        {detail.doneActions.length > 0 && (
          <>
            <button
              type="button" class="btn project-toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}
            >{showDone ? 'Hide' : 'Show'} done actions ({detail.doneActions.length})</button>
            {showDone && (
              <List
                items={detail.doneActions} label="Done actions"
                render={(a: Action) => renderAction(a, true)} actions={rowActions}
              />
            )}
          </>
        )}
      </section>

      <section class="project-section" aria-label="Notes">
        <h3 class="project-section-title">Notes</h3>
        <List
          items={detail.notes} label="Project notes" empty="No notes yet."
          render={(n: NoteSummary) => (
            <>
              <span>{n.title || oneLine(n.preview, 80)}</span>
              {n.title && n.preview && <span class="proj-tag">{oneLine(n.preview, 60)}</span>}
            </>
          )}
          actions={(n: NoteSummary) => [{ id: 'open', label: 'Open', run: () => openDoc({ kind: 'note', id: n.id }) }]}
          onAdd={adder((text) => api.post('/api/notes', { bodyMd: text, projectId: id }))} draftId={`project:${id}:notes`}
          addPlaceholder="Add a note…"
        />
      </section>

      <button type="button" class="btn danger project-danger" onClick={deleteProject}>Delete project</button>

      {editing && (
        <EditActionDialog
          label="Edit action" initial={editing.text}
          onCancel={() => setEditing(null)}
          onSubmit={(v) => {
            const a = editing;
            setEditing(null);
            if (v !== a.text) void patchAction(a, { text: v }).catch((err: unknown) => flash(errorText(err), 'error'));
          }}
        />
      )}

      {personFor !== null && (
        <ItemPicker
          kind="person" allowNone onCancel={() => setPersonFor(null)}
          onPick={(pid) => {
            const aid = personFor;
            setPersonFor(null);
            void write(() => api.patch(`/api/actions/${aid}`, { personId: pid })).catch((err: unknown) => flash(errorText(err), 'error'));
          }}
        />
      )}
    </div>
  );
}
