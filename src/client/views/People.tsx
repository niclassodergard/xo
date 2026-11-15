import { useEffect } from 'preact/hooks';
import type { MeetingDetail, Person } from '../../shared/types.ts';
import { Pane } from '../components/Pane.tsx';
import { SelectableList } from '../components/SelectableList.tsx';
import { api } from '../lib/api.ts';
import { useKeys } from '../lib/keys.ts';
import { navigate } from '../lib/router.ts';
import { askText, epoch, errorText, flash, people, refreshPeople } from '../lib/store.ts';

/** People list (name + aliases). `a` adds, Enter opens, `s` starts (or resumes) a 1-1. */
export default function People() {
  useEffect(() => { void refreshPeople(); }, []); // GET only

  function add(): void {
    askText('New person', (name) => {
      const e = epoch();
      api.post<Person>('/api/people', { name }).then(async () => {
        await refreshPeople();
        if (e === epoch()) flash(`Added ${name}`);
      }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
    });
  }

  function start(p: Person): void {
    const e = epoch();
    api.post<MeetingDetail>(`/api/people/${p.id}/meetings`).then((m) => {
      if (e === epoch()) navigate(`/meetings/${m.meeting.id}`);
    }).catch((err) => { if (e === epoch()) flash(errorText(err), 'error'); });
  }

  useKeys({ a: add }, { descriptions: { a: 'add person' } });

  const list = people.value.filter((p) => p.archivedAt === null);
  return (
    <Pane title="People" focused>
      <SelectableList
        items={list}
        empty="No people yet. Press a to add one."
        onOpen={(p) => navigate(`/people/${p.id}`)}
        keyDescriptions={{ s: 'start 1-1' }}
        keys={{ s: start }}
        render={(p) => (
          <>
            <span>{p.name}</span>
            {p.aliases.length > 0 && <span class="dim">{`  (${p.aliases.join(', ')})`}</span>}
          </>
        )}
      />
      <div class="hint">Enter open · a add · s start 1-1</div>
    </Pane>
  );
}
