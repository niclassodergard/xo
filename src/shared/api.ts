import type {
  Action, AgendaItem, Capture, Id, Meeting, MeetingDetail, NavItem, NavKind, Owner, Person, PersonDetail, Project, ProjectStatus,
  SearchResult,
} from './types.ts';

// Request/response types for the HTTP API (see plan section 4.5).

export interface ApiErrorBody { error: { code: string; message: string } }

export interface LoginRequest { password: string; totp: string }
export interface SessionResponse { csrfToken: string }

export interface PeopleListResponse { people: Person[] }
export interface CreatePersonRequest { name: string; aliases?: string[] }
export interface UpdatePersonRequest { name?: string; aliases?: string[]; notesMd?: string; archived?: boolean }
/** Note as returned by list endpoints: a preview instead of the full body (full body: GET /notes/:id). */
export interface NoteSummary { id: Id; title: string; preview: string; personId: Id | null; projectId: Id | null; createdAt: string; updatedAt: string }
/** Meeting without its notes: `preview` is the first 280 characters of the notes (full: GET /meetings/:id). */
export interface MeetingHeader { id: Id; personId: Id; startedAt: string; endedAt: string | null; preview: string }
export interface MeetingHeadersResponse { meetings: MeetingHeader[] }
/** PersonDetail with note previews (latest 50) and meeting headers (latest 50; page back with GET /people/:id/meetings). */
export type PersonDetailResponse = Omit<PersonDetail, 'notes' | 'meetings'> & { notes: NoteSummary[]; meetings: MeetingHeader[] };

export interface NotesListResponse { notes: NoteSummary[] }
export interface ProjectSummary { id: Id; title: string; aliases: string[]; status: ProjectStatus; openActions: number; updatedAt: string }
export interface ProjectsListResponse { projects: ProjectSummary[] }
export interface CreateProjectRequest { title: string; aliases?: string[]; status?: ProjectStatus; descriptionMd?: string }
export interface UpdateProjectRequest { title?: string; aliases?: string[]; status?: ProjectStatus; descriptionMd?: string }
/** Latest 50 done actions and latest 50 note previews (LIMITS.projectActionsDone, projectNotes). */
export interface ProjectDetailResponse { project: Project; people: Person[]; openActions: Action[]; doneActions: Action[]; notes: NoteSummary[] }

export interface NavResponse { pinned: NavItem[]; recents: NavItem[] }
export interface TouchRecentRequest { kind: NavKind; id: Id }

export interface CreateNoteRequest { title?: string; bodyMd: string; personId?: Id | null; projectId?: Id | null }
export interface UpdateNoteRequest { title?: string; bodyMd?: string; personId?: Id | null; projectId?: Id | null }

export interface ActionsListResponse { actions: Action[] }
export interface CreateActionRequest { text: string; owner?: Owner; personId?: Id | null; meetingId?: Id | null; projectId?: Id | null }
export interface UpdateActionRequest { text?: string; owner?: Owner; status?: 'open' | 'done'; personId?: Id | null; projectId?: Id | null }

export interface CreateAgendaItemRequest { text: string }
export interface UpdateAgendaItemRequest { text?: string; status?: AgendaItem['status']; meetingId?: Id }

export type MeetingDetailResponse = MeetingDetail;
export interface UpdateMeetingRequest { notesMd: string }
export type MeetingResponse = Meeting;

/** Search is POST so the query text never appears in URLs or proxy access logs. */
export interface SearchRequest { q: string; limit?: number }
/** `archived` is true only for person hits, and meeting hits, whose person is archived. */
export type SearchHit = SearchResult & { archived: boolean };
export interface SearchResponse { results: SearchHit[] }

export interface CapturesListResponse { captures: Capture[] }
export interface CreateCaptureRequest { text: string; source: 'text' | 'voice' }
export type AnswerCaptureRequest = { key: string } | { personId: Id } | { projectId: Id };

export interface TranscribeResponse { text: string }

/** Length caps enforced by route schemas. */
export const LIMITS = {
  captureText: 10_000,
  name: 200,
  markdown: 200_000,
  notePreview: 280,
  personMeetings: 50,
  personNotes: 50,
  projectActionsDone: 50,
  projectNotes: 50,
  recents: 15,
  recentsStored: 50,
  pins: 50,
} as const;
