import { useEffect, useLayoutEffect } from 'preact/hooks';
import { ItemPicker } from './components/ItemPicker.tsx';
import { Confirm } from './components/Confirm.tsx';
import { Help } from './components/Help.tsx';
import { Palette } from './components/Palette.tsx';
import { Prompt } from './components/Prompt.tsx';
import { createPerson, createProject, startMeeting } from './lib/commands.ts';
import { focusTarget } from './lib/focus.ts';
import { installKeyListeners, isTextEntry, registerCommand, useKeys } from './lib/keys.ts';
import { KEY_COMPOSER, KEY_COMPOSER_ALT, KEY_ESC, KEY_PALETTE, KEY_SIDEBAR } from './lib/keymap.ts';
import {
  chatVisible, escAction, goToComposer, panelExpanded, sidebarOpen, singlePanel, toggleExpanded, toggleSidebar,
} from './lib/layout.ts';
import { openDoc } from './lib/nav.ts';
import { closePanel, isPanelRoute, navigate, route } from './lib/router.ts';
import {
  appPhase, askPick, askText, booted, confirmRequest, initAuthChannel, logout, overlay, pickRequest, promptRequest,
  refreshNav, refreshPeople, refreshProjects, restoreSession, revalidateSession, session, shellActive, togglePalette,
  toggleHelp,
} from './lib/store.ts';
import { Panel } from './shell/Panel.tsx';
import { Sidebar } from './shell/Sidebar.tsx';
import { Toasts } from './shell/Toasts.tsx';
import Composer from './stream/Composer.tsx';
import Stream from './stream/Stream.tsx';
import Login from './views/Login.tsx';
import { initVoice } from './voice/index.ts';
import VoiceStatus from './voice/VoiceStatus.tsx';

/** Esc once no overlay or recording took it (those register modal layers, which win): see escAction(). */
function globalEsc(): void {
  const a = document.activeElement;
  const inPanelField = isTextEntry(a) && !!a?.closest('[data-region="panel"]');
  const act = escAction({ textEntryInPanel: inPanelField, panelOpen: isPanelRoute(route.peek()) });
  if (act === 'blur-field') {
    (a as HTMLElement).blur();
    focusTarget('panel', { queue: false });
  } else if (act === 'close-panel') {
    closePanel();
    focusTarget('composer'); // queued: in single-panel mode the composer renders after the route change
  } else {
    focusTarget('composer', { queue: false });
  }
}

function GlobalKeys(props: { enabled: boolean }) {
  useKeys({
    [KEY_PALETTE]: togglePalette,
    [KEY_COMPOSER]: goToComposer,
    [KEY_COMPOSER_ALT]: goToComposer,
    [KEY_SIDEBAR]: toggleSidebar,
    [KEY_ESC]: globalEsc,
  }, {
    scope: 'global', enabled: props.enabled,
    descriptions: {
      [KEY_PALETTE]: 'search and commands', [KEY_COMPOSER]: 'new capture', [KEY_COMPOSER_ALT]: 'new capture (best effort)',
      [KEY_SIDEBAR]: 'toggle sidebar', [KEY_ESC]: 'close / leave field / focus composer',
    },
  });
  return null;
}

function useBuiltinCommands(enabled: boolean): void {
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const go = (id: string, title: string, run: () => void, keywords: string[] = []) => registerCommand({ id, title, run, keywords });
    const offs = [
      go('go.home', 'Go to conversation', () => { navigate('/'); }, ['home', 'chat']),
      go('go.actions', 'Go to Actions', () => openDoc({ kind: 'actions' }), ['todo', 'tasks']),
      go('go.notes', 'Go to Notes', () => openDoc({ kind: 'notes' })),
      go('go.people', 'Go to People', () => openDoc({ kind: 'people' })),
      go('go.projects', 'Go to Projects', () => openDoc({ kind: 'projects' })),
      go('meeting.start', 'Start 1-1 with…', () => askPick('person', (id) => { void startMeeting(id); }), ['meeting', 'one on one']),
      go('person.new', 'New person', () => askText('New person', (name) => { void createPerson(name); }), ['add']),
      go('project.new', 'New project', () => askText('New project', (title) => { void createProject(title); }), ['add']),
      go('sidebar.toggle', 'Toggle sidebar', toggleSidebar, ['drawer', 'menu']),
      go('panel.expand', 'Expand or collapse the document', () => { if (isPanelRoute(route.peek()) && !singlePanel.peek()) toggleExpanded(); }, ['panel', 'wide']),
      go('panel.close', 'Close the document', () => { if (isPanelRoute(route.peek())) closePanel(); }, ['panel']),
      go('help', 'Shortcuts', toggleHelp, ['keys', 'bindings', 'help']),
      go('logout', 'Log out', () => { void logout(); }, ['sign out']),
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
  useEffect(() => {
    if (!token) return;
    void refreshPeople();
    void refreshProjects();
    void refreshNav();
  }, [token]);
  useBuiltinCommands(loggedIn);
  // Voice bindings exist only while a session exists (never on the Login screen). Layout effect:
  // key layers must exist before the first keystroke after paint (CLAUDE.md).
  useLayoutEffect(() => {
    if (!loggedIn) return undefined;
    const cleanup = initVoice();
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [loggedIn]);

  const phase = appPhase(booted.value, shellActive.value, loggedIn);
  if (phase === 'boot') return <div class="boot">XO …</div>;
  if (phase === 'login') return <Login />;
  // After a 401 the shell stays (hidden, inert) with Login on top; the stream and the panel are unmounted so no
  // server-loaded content remains in the DOM. Typed text lives in store signals (see store.ts, convention 2).
  const locked = phase === 'locked';

  const panelOpen = isPanelRoute(route.value);
  const single = singlePanel.value;
  const expanded = panelOpen && !single && panelExpanded.value;
  const sidebar = sidebarOpen.value;
  const showChat = chatVisible(panelOpen, single, expanded);
  const pick = pickRequest.value;

  return (
    <>
    <div
      class={`app${locked ? ' locked' : ''}`} data-single={String(single)} data-sidebar={sidebar ? 'open' : 'closed'}
      data-panel={panelOpen ? 'open' : 'closed'} data-expanded={String(expanded)}
      aria-hidden={locked ? 'true' : undefined} ref={(el) => { if (el) el.inert = locked; }}
    >
      <GlobalKeys enabled={!locked} />
      <Sidebar />
      <main class="main">
        {(!sidebar || single) && showChat && (
          <button type="button" class="icon-btn sidebar-toggle" aria-label="Show sidebar" title="Show sidebar (Cmd-B)" onClick={toggleSidebar}>☰</button>
        )}
        {!locked && showChat && (
          <section class="chat-col" aria-label="Chat">
            <div class="chat-inner">
              <Stream />
              <Composer />
            </div>
          </section>
        )}
        {!locked && panelOpen && <Panel />}
      </main>
      <Toasts />
      {!locked && <VoiceStatus />}
      {overlay.value === 'palette' && <Palette />}
      {overlay.value === 'help' && <Help />}
      {pick && <ItemPicker kind={pick.kind} onPick={(id) => { pickRequest.value = null; pick.onPick(id); }} onCancel={() => { pickRequest.value = null; }} />}
      {promptRequest.value && <Prompt />}
      {confirmRequest.value && <Confirm />}
    </div>
    {locked && <div class="lock"><Login /></div>}
    </>
  );
}
