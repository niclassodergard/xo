export type Id = number;
export type ItemKind = 'note' | 'action' | 'agenda';
export type Owner = 'me' | 'them';

export interface Person { id: Id; name: string; aliases: string[]; notesMd: string; createdAt: string; updatedAt: string; archivedAt: string | null }
export interface Note { id: Id; title: string; bodyMd: string; personId: Id | null; createdAt: string; updatedAt: string }
export interface Action { id: Id; text: string; owner: Owner; status: 'open' | 'done'; personId: Id | null; meetingId: Id | null; createdAt: string; doneAt: string | null }
export interface AgendaItem { id: Id; personId: Id; text: string; status: 'open' | 'done' | 'dropped'; createdAt: string; resolvedAt: string | null; resolvedMeetingId: Id | null }
export interface Meeting { id: Id; personId: Id; startedAt: string; endedAt: string | null; notesMd: string }

export interface ItemRef { kind: ItemKind | 'person'; id: Id }
export interface CaptureDraft { kind: ItemKind | null; text: string; personId: Id | null; personName: string | null; owner: Owner }
export interface ChoiceOption { key: string; label: string }            // key = single-character hotkey
export type CaptureQuestion =
  | { type: 'kind'; options: ChoiceOption[] }                           // n note, t action, a agenda, d discard
  | { type: 'unknown_person'; name: string; options: ChoiceOption[] }   // c create, p pick existing, s skip (not for agenda), d discard
  | { type: 'ambiguous_person'; name: string; candidates: { key: string; personId: Id; name: string }[]; options: ChoiceOption[] } // 1..9, s skip (not for agenda), d discard
  | { type: 'needs_person'; options: ChoiceOption[] };                  // p pick existing, d discard (agenda item without a person)
export interface Capture {
  id: Id; text: string; source: 'text' | 'voice';
  status: 'pending' | 'filed' | 'undone' | 'discarded';
  draft: CaptureDraft; question: CaptureQuestion | null;
  filed: ItemRef[]; summary: string;                                    // e.g. "Action (me) · Anna: send budget"
  classifiedBy: 'prefix' | 'llm' | 'user' | null; createdAt: string;
  deleted: boolean;                                                     // true: every filed item is gone; text/draft/summary are redacted (list only)
}
export interface SearchResult { kind: ItemKind | 'person' | 'meeting'; id: Id; title: string; snippet: string; personId: Id | null }
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
  | { type: 'goto'; view: 'chat' | 'actions' | 'notes' | 'people' };
