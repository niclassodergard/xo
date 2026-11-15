import type { ComponentType } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { registerFocusTarget } from '../lib/focus.ts';
import { modalOpen } from '../lib/keys.ts';
import { panelExpanded, singlePanel, toggleExpanded } from '../lib/layout.ts';
import { back, closePanel, route } from '../lib/router.ts';
import type { RouteName } from '../lib/router.ts';
import { panelTitle } from '../lib/store.ts';
import KitDemo from '../components/KitDemo.tsx';
import ActionsDoc from '../docs/ActionsDoc.tsx';
import MeetingDoc from '../docs/MeetingDoc.tsx';
import NoteDoc from '../docs/NoteDoc.tsx';
import NotesDoc from '../docs/NotesDoc.tsx';
import PeopleDoc from '../docs/PeopleDoc.tsx';
import PersonDoc from '../docs/PersonDoc.tsx';
import ProjectDoc from '../docs/ProjectDoc.tsx';
import ProjectsDoc from '../docs/ProjectsDoc.tsx';

const DOCS: Partial<Record<RouteName, ComponentType>> = {
  actions: ActionsDoc, notes: NotesDoc, note: NoteDoc, people: PeopleDoc, person: PersonDoc,
  projects: ProjectsDoc, project: ProjectDoc, meeting: MeetingDoc,
};
const TITLES: Partial<Record<RouteName, string>> = {
  actions: 'Actions', notes: 'Notes', note: 'Note', people: 'People', person: 'Person',
  projects: 'Projects', project: 'Project', meeting: '1-1', notfound: 'Not found',
};
const DETAIL = new Set<RouteName>(['note', 'person', 'project', 'meeting']);

/**
 * The document named by the route (never rendered on home). Header: back, title, expand/collapse, close.
 * It is the `panel` focus target; with focus on the panel itself, Down moves into its first list.
 * Closing is closePanel() (lib/router.ts); Esc is handled by the global Esc ladder in app.tsx.
 */
export function Panel() {
  const el = useRef<HTMLElement>(null);
  useLayoutEffect(() => registerFocusTarget('panel', () => el.current), []);
  const r = route.value;
  const Doc = DOCS[r.name];
  const single = singlePanel.value;
  const expanded = panelExpanded.value;
  const title = panelTitle.value || TITLES[r.name] || '';

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' || e.target !== e.currentTarget || modalOpen()) return;
    const first = el.current?.querySelector<HTMLElement>('[role=listbox]');
    if (first) { e.preventDefault(); first.focus(); }
  };

  return (
    <section class="panel" data-region="panel" role="region" aria-label="Document" tabIndex={-1} ref={el} onKeyDown={onKeyDown}>
      <header class="panel-head">
        {(single || DETAIL.has(r.name)) && (
          <button type="button" class="icon-btn" aria-label="Back" title="Back" onClick={back}>←</button>
        )}
        <h2 class="panel-title">{title}</h2>
        {!single && (
          <button
            type="button" class="icon-btn" aria-label={expanded ? 'Collapse document' : 'Expand document'}
            aria-pressed={expanded} title={expanded ? 'Collapse' : 'Expand'} onClick={toggleExpanded}
          >{expanded ? '⇲' : '⇱'}</button>
        )}
        <button type="button" class="icon-btn" aria-label="Close document" title="Close (Esc)" onClick={closePanel}>✕</button>
      </header>
      <div class="panel-body">
        {import.meta.env.MODE === 'e2e' && r.name === 'notfound' && window.location.hash === '#/kit' ? <KitDemo />
          : Doc ? <Doc key={`${r.name}:${r.params['id'] ?? ''}`} /> : <p class="muted">No such page.</p>}
      </div>
    </section>
  );
}
