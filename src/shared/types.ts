export type Id = number;
export type ItemKind = 'note' | 'action' | 'agenda';
export type Owner = 'me' | 'them';

export interface Person { id: Id; name: string; aliases: string[]; notesMd: string; createdAt: string; updatedAt: string; archivedAt: string | null }
export type ProjectStatus = 'active' | 'on_hold' | 'done';
export interface Project { id: Id; title: string; aliases: string[]; status: ProjectStatus; descriptionMd: string; createdAt: string; updatedAt: string }
export interface Note { id: Id; title: string; bodyMd: string; personId: Id | null; projectId: Id | null; createdAt: string; updatedAt: string }
export interface Action { id: Id; text: string; owner: Owner; status: 'open' | 'done'; personId: Id | null; meetingId: Id | null; projectId: Id | null; createdAt: string; doneAt: string | null }
export interface AgendaItem { id: Id; personId: Id; text: string; status: 'open' | 'done' | 'dropped'; createdAt: string; resolvedAt: string | null; resolvedMeetingId: Id | null }
export interface Meeting { id: Id; personId: Id; startedAt: string; endedAt: string | null; notesMd: string }

export interface ItemRef { kind: ItemKind | 'person' | 'project'; id: Id }
export interface CaptureDraft { kind: ItemKind | 'question' | null; text: string; personId: Id | null; personName: string | null; projectId: Id | null; projectName: string | null; owner: Owner }
export interface ChoiceOption { key: string; label: string }            // key = the answer token sent to the server (not a client hotkey)
export type CaptureQuestion =
  | { type: 'kind'; options: ChoiceOption[] }                           // n note, t action, a agenda, q answer it (a question), d discard
  | { type: 'unknown_person'; name: string; options: ChoiceOption[] }   // c create, p pick existing, s skip (not for agenda), d discard
  | { type: 'ambiguous_person'; name: string; candidates: { key: string; personId: Id; name: string }[]; options: ChoiceOption[] } // 1..9, s skip (not for agenda), d discard
  | { type: 'needs_person'; options: ChoiceOption[] }                   // p pick existing, d discard (agenda item without a person)
  | { type: 'unknown_project'; name: string; options: ChoiceOption[] }  // c create, p pick existing, s skip, d discard
  | { type: 'ambiguous_project'; name: string; candidates: { key: string; projectId: Id; title: string }[]; options: ChoiceOption[] }; // 1..9, s skip, d discard
/** A document the answer drew on. `title` is looked up when the capture is read, never stored. */
export interface SourceRef { kind: 'note' | 'action' | 'agenda' | 'person' | 'project' | 'meeting'; id: Id; title: string }
/** `redacted`: an item the answer used was deleted, so the text and sources are blanked (text '' and sources []). */
export interface CaptureAnswer { text: string; sources: SourceRef[]; redacted: boolean }
export interface Capture {
  id: Id; text: string; source: 'text' | 'voice';
  // 'asked': a question waiting for POST /captures/:id/ask; 'answered': answer is set.
  status: 'pending' | 'filed' | 'undone' | 'discarded' | 'asked' | 'answered';
  draft: CaptureDraft; question: CaptureQuestion | null;
  filed: ItemRef[]; summary: string;                                    // e.g. "Action (me) · Anna: send budget"
  classifiedBy: 'prefix' | 'llm' | 'user' | null; createdAt: string;
  deleted: boolean;                                                     // true: every filed item is gone; text/draft/summary are redacted (list only)
  answer: CaptureAnswer | null;                                         // set only while status is 'answered'
}
export interface SearchResult { kind: ItemKind | 'person' | 'meeting' | 'project'; id: Id; title: string; snippet: string; personId: Id | null }
export interface PersonDetail { person: Person; openAgenda: AgendaItem[]; openActions: Action[]; notes: Note[]; meetings: Meeting[]; activeMeetingId: Id | null }
export interface MeetingDetail {
  meeting: Meeting; person: Person;
  openAgenda: AgendaItem[]; resolvedHere: AgendaItem[];
  actionsHere: Action[]; otherOpenActions: Action[];
  previous: { meeting: Meeting; resolved: AgendaItem[]; actions: Action[] } | null;
}
export type VoiceCommand =
  | { type: 'open_person'; personId: Id }
  | { type: 'start_meeting'; personId: Id }
  | { type: 'open_project'; projectId: Id }
  | { type: 'goto'; view: 'home' | 'actions' | 'notes' | 'people' | 'projects' };

export type NavKind = 'person' | 'project' | 'meeting' | 'note';
export interface NavItem { kind: NavKind; id: Id; title: string; archived: boolean }
