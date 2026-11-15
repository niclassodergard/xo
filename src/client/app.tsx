import type { ComponentType } from 'preact';
import { useEffect } from 'preact/hooks';
import type { MeetingDetail, Person } from '../shared/types.ts';
import { Help } from './components/Help.tsx';
import { Overlay } from './components/Overlay.tsx';
import { Palette } from './components/Palette.tsx';
import { Pane } from './components/Pane.tsx';
import { PersonPicker } from './components/PersonPicker.tsx';
import { Prompt } from './components/Prompt.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { api } from './lib/api.ts';
import { installKeyListeners, mode, registerCommand, useKeys } from './lib/keys.ts';
import { back, navigate, route } from './lib/router.ts';
import {
  appPhase, askText, booted, closeOverlay, epoch, errorText, flash, focusChatInput, focusSearchInput, initAuthChannel, logout,
  overlay, personPicker, pickPerson, promptRequest, refreshPeople, restoreSession, revalidateSession,
  session, shellActive, toggleHelp, togglePalette, undoLastCapture,
} from './lib/store.ts';
import Actions from './views/Actions.tsx';
import Chat from './views/Chat.tsx';
import Login from './views/Login.tsx';
import Meeting from './views/Meeting.tsx';
import NoteDetail from './views/NoteDetail.tsx';
import Notes from './views/Notes.tsx';
import People from './views/People.tsx';
import PersonView from './views/Person.tsx';
import Search from './views/Search.tsx';
import { cycleView } from './views/nav-logic.ts';
import { initVoice } from './voice/index.ts';

const VIEWS: Record<string, ComponentType> = {
  chat: Chat, actions: Actions, notes: Notes, note: NoteDetail, people: People, person: PersonView, meeting: Meeting, search: Search,
};
const TITLES: Record<string, string> = {
  chat: 'Chat', actions: 'Actions', notes: 'Notes', note: 'Note', people: 'People', person: 'Person', meeting: '1-1', search: 'Search',
  notfound: 'Not found',
};
const NAV = [
  { href: '/chat', label: 'Chat', keys: 'g c', names: ['chat'] },
  { href: '/actions', label: 'Actions', keys: 'g a', names: ['actions'] },
  { href: '/notes', label: 'Notes', keys: 'g n', names: ['notes', 'note'] },
  { href: '/people', label: 'People', keys: 'g p', names: ['people', 'person', 'meeting'] },
];

async function startMeetingWith(p: Person): Promise<void> {
  const e = epoch();
  try {
    const m = await api.post<MeetingDetail>(`/api/people/${p.id}/meetings`);
    if (e === epoch()) navigate(`/meetings/${m.meeting.id}`);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}

async function createPerson(name: string): Promise<void> {
  const e = epoch();
  try {
    const p = await api.post<Person>('/api/people', { name });
    if (e !== epoch()) return;
    await refreshPeople();
    if (e === epoch()) navigate(`/people/${p.id}`);
  } catch (err) {
    if (e === epoch()) flash(errorText(err), 'error');
  }
}

function blurActive(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  mode.value = 'normal';
}

function GlobalKeys(props: { enabled: boolean }) {
  const { enabled } = props;
  useKeys({
    'g c': () => navigate('/chat'),
    'g a': () => navigate('/actions'),
    'g n': () => navigate('/notes'),
    'g p': () => navigate('/people'),
    i: () => { navigate('/chat'); focusChatInput(); },
    '/': () => { navigate('/search'); focusSearchInput(); },
    ':': togglePalette,
    '?': toggleHelp,
    left: () => navigate(cycleView(NAV, route.peek().name, -1)),
    right: () => navigate(cycleView(NAV, route.peek().name, 1)),
  }, {
    scope: 'global', enabled,
    descriptions: {
      'g c': 'go to chat', 'g a': 'go to actions', 'g n': 'go to notes', 'g p': 'go to people',
      i: 'chat input', '/': 'search', ':': 'command palette', '?': 'help',
      left: 'previous view (Chat · Actions · Notes · People)', right: 'next view (Chat · Actions · Notes · People)',
    },
  });
  useKeys({
    'ctrl+k': () => togglePalette(),
    esc: () => {
      if (overlay.value) closeOverlay();
      else if (mode.value === 'insert') blurActive();
      else back();
    },
  }, {
    scope: 'global', enabled, modes: ['normal', 'insert', 'command'],
    descriptions: { 'ctrl+k': 'command palette', esc: 'close / leave input / back' },
  });
  return null;
}

function useBuiltinCommands(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const go = (id: string, title: string, path: string, kw: string[]) =>
      registerCommand({ id, title, run: () => navigate(path), keywords: kw });
    const offs = [
      go('go.chat', 'Go to Chat', '/chat', ['home']),
      go('go.actions', 'Go to Actions', '/actions', ['todo', 'tasks']),
      go('go.notes', 'Go to Notes', '/notes', []),
      go('go.people', 'Go to People', '/people', []),
      go('go.search', 'Search', '/search', ['find']),
      registerCommand({ id: 'meeting.start', title: 'Start 1-1 with…', keywords: ['meeting', 'one on one'], run: () => pickPerson((p) => { personPicker.value = null; void startMeetingWith(p); }) }),
      registerCommand({ id: 'person.new', title: 'New person', keywords: ['add'], run: () => askText('New person', (name) => { void createPerson(name); }) }),
      registerCommand({ id: 'capture.undo', title: 'Undo last capture', run: () => { void undoLastCapture(); } }),
      registerCommand({ id: 'help', title: 'Help', keywords: ['keys', 'bindings'], run: toggleHelp }),
      registerCommand({ id: 'logout', title: 'Log out', keywords: ['sign out'], run: () => { void logout(); } }),
    ];
    return () => offs.forEach((off) => off());
  }, [enabled]);
}

export function App() {
  useEffect(() => {
    const uninstall = installKeyListeners();
    const closeChannel = initAuthChannel();
    void restoreSession();
    // Re-validate when the user comes back to the tab (no timer: polling would keep the idle timeout from firing).
    const onVisible = () => { if (document.visibilityState === 'visible') void revalidateSession(); };
    const onFocus = () => { void revalidateSession(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      uninstall(); closeChannel();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const loggedIn = session.value !== null;
  const token = session.value?.csrfToken;
  useEffect(() => { if (token) void refreshPeople(); }, [token]);
  useBuiltinCommands(loggedIn);
  // Voice bindings exist only while a session exists (never on the Login screen).
  useEffect(() => {
    if (!loggedIn) return undefined;
    const cleanup = initVoice();
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [loggedIn]);

  const phase = appPhase(booted.value, shellActive.value, loggedIn);
  if (phase === 'boot') return <div class="boot">XO …</div>;
  if (phase === 'login') return <Login />;
  // After a 401 the shell stays (hidden, inert) with Login on top, and the views are unmounted so no
  // server-loaded content remains in the DOM. Drafts live in store signals (see store.ts, convention 2).
  const locked = phase === 'locked';

  const r = route.value;
  const View = VIEWS[r.name];
  const picker = personPicker.value;
  return (
    <>
    <div class={`app${locked ? ' locked' : ''}`} aria-hidden={locked ? 'true' : undefined} ref={(el) => { if (el) el.inert = locked; }}>
      <GlobalKeys enabled={!locked} />
      <header class="header">
        <span class="brand">XO</span>
        <span class="dim"> · </span>
        <span class="title">{TITLES[r.name] ?? ''}</span>
        <span class="spacer" />
        <button type="button" class="tbtn" onClick={() => { void logout(); }}>log out</button>
      </header>
      <nav class="nav" aria-label="Views">
        <Pane title="XO">
          {NAV.map((n) => (
            <a key={n.href} href={`#${n.href}`} class={`navlink${n.names.includes(r.name) ? ' active' : ''}`}>
              <span>{n.label}</span><span class="dim keyhint">{n.keys}</span>
            </a>
          ))}
        </Pane>
      </nav>
      <main class="main">
        {locked ? null : View ? <View key={`${r.name}:${r.params.id ?? ''}`} /> : <Pane title="Not found">No such view. Press g c for chat.</Pane>}
      </main>
      <StatusBar />
      {overlay.value === 'palette' && <Palette />}
      {overlay.value === 'help' && <Help />}
      {picker && (
        <Overlay label="Pick person">
          <PersonPicker onPick={(p) => { personPicker.value = null; picker.onPick(p); }} onCancel={() => { personPicker.value = null; }} />
        </Overlay>
      )}
      {promptRequest.value && <Prompt />}
    </div>
    {locked && <div class="lock"><Login /></div>}
    </>
  );
}
