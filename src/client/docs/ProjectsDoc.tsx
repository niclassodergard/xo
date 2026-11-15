import { useEffect } from 'preact/hooks';
import type { ProjectSummary } from '../../shared/api.ts';
import { List } from '../components/List.tsx';
import type { Project } from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { keystrokeMark } from '../lib/keys.ts';
import { openDoc, openDocAsync } from '../lib/nav.ts';
import { epoch, errorText, flash, projects, refreshProjects, usePanelTitle } from '../lib/store.ts';
import { groupProjects, openCountLabel } from './project-logic.ts';
import '../styles/docs-projects.css';

/** The Projects list document: Active / On hold / Done, open-action counts, and an add field (Active group). */
export default function ProjectsDoc() {
  usePanelTitle('Projects');
  useEffect(() => { void refreshProjects(); }, []);
  const add = async (title: string): Promise<void> => {
    const e = epoch();
    const mark = keystrokeMark();
    let created: Project;
    try {
      created = await api.post<Project>('/api/projects', { title });
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // keeps the typed text in the add field
    }
    if (e !== epoch()) return;
    await refreshProjects();
    if (e === epoch()) openDocAsync({ kind: 'project', id: created.id }, mark);
  };
  const groups = groupProjects(projects.value);

  const render = (p: ProjectSummary) => (
    <>
      <span class="proj-title">{p.title}</span>
      {openCountLabel(p.openActions) && <span class="proj-count muted">{openCountLabel(p.openActions)}</span>}
    </>
  );
  const rowActions = (p: ProjectSummary) => [{ id: 'open', label: 'Open', run: () => openDoc({ kind: 'project', id: p.id }) }];

  return (
    <div class="projects-doc">
      {groups.map((g) => (g.status === 'active' || g.items.length > 0) && (
        <section key={g.status} class="proj-group" aria-label={g.label}>
          <h3 class="proj-group-title">{g.label}</h3>
          {g.status === 'active' ? (
            <List
              items={g.items} label={`${g.label} projects`} render={render} actions={rowActions}
              empty="No active projects." onAdd={add} draftId="projects:active:add"
              addPlaceholder="New project…"
            />
          ) : (
            <List items={g.items} label={`${g.label} projects`} render={render} actions={rowActions} />
          )}
        </section>
      ))}
    </div>
  );
}
