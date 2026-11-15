import type { MeetingDetail, Person, Project } from '../../shared/types.ts';
import type { Id } from '../../shared/types.ts';
import { api } from './api.ts';
import { keystrokeMark } from './keys.ts';
import { openDocAsync } from './nav.ts';
import { epoch, errorText, flash, refreshPeople, refreshProjects } from './store.ts';

// Shared by the palette, voice and the documents. Each checks the session epoch after every await, so a
// result that arrives after the session ended does nothing.

/**
 * Start (or resume) the open 1-1 with a person and open it. `mark` is `keystrokeMark()` taken when the user
 * action began (voice passes the mark from when transcription started); default: now.
 */
export async function startMeeting(personId: Id, mark: number = keystrokeMark()): Promise<void> {
  const e = epoch();
  try {
    const m = await api.post<MeetingDetail>(`/api/people/${personId}/meetings`);
    if (e === epoch()) openDocAsync({ kind: 'meeting', id: m.meeting.id }, mark);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}

export async function createPerson(name: string): Promise<void> {
  const e = epoch();
  const mark = keystrokeMark();
  try {
    const p = await api.post<Person>('/api/people', { name });
    if (e !== epoch()) return;
    await refreshPeople();
    if (e === epoch()) openDocAsync({ kind: 'person', id: p.id }, mark);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}

export async function createProject(title: string): Promise<void> {
  const e = epoch();
  const mark = keystrokeMark();
  try {
    const p = await api.post<Project>('/api/projects', { title });
    if (e !== epoch()) return;
    await refreshProjects();
    if (e === epoch()) openDocAsync({ kind: 'project', id: p.id }, mark);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}
