import { useEffect } from 'preact/hooks';
import type { Person } from '../../shared/types.ts';
import { List } from '../components/List.tsx';
import { api } from '../lib/api.ts';
import { startMeeting } from '../lib/commands.ts';
import { openDoc } from '../lib/nav.ts';
import { epoch, errorText, flash, people, refreshPeople, usePanelTitle } from '../lib/store.ts';
import '../styles/docs-people.css';

/** People list: Enter opens the person; the second chip starts (or resumes) a 1-1. The add field creates a person. */
export default function PeopleDoc() {
  usePanelTitle('People');
  useEffect(() => { void refreshPeople(); }, []); // a read only

  const add = async (name: string): Promise<void> => {
    const e = epoch();
    try {
      await api.post<Person>('/api/people', { name });
    } catch (err) {
      if (e === epoch()) flash(errorText(err), 'error');
      throw err; // keeps the typed text in the add field
    }
    if (e !== epoch()) return;
    await refreshPeople();
    if (e === epoch()) flash(`Added ${name}`);
  };

  const list = people.value.filter((p) => p.archivedAt === null);
  return (
    <div class="doc-people">
      <List
        label="People"
        items={list}
        empty="No people yet. Type a name below to add one."
        draftId="people:all:add"
        addPlaceholder="Add a person…"
        onAdd={add}
        render={(p) => (
          <>
            <span>{p.name}</span>
            {p.aliases.length > 0 && <span class="muted">{`  (${p.aliases.join(', ')})`}</span>}
          </>
        )}
        actions={(p) => [
          { id: 'open', label: 'Open', run: () => openDoc({ kind: 'person', id: p.id }) },
          { id: 'start', label: 'Start 1-1', run: () => startMeeting(p.id) },
        ]}
      />
    </div>
  );
}
