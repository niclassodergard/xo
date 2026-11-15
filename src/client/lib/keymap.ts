// Every shortcut XO defines, in one place. The Help overlay and the README read this list; bindings in the
// code use the named spec constants. Letters only (Swedish keyboards need Shift for / ? :), never
// Option+letter (it types a character), nothing the browser or macOS takes (Cmd-T/W/Q/H/M/L/R, Ctrl-arrows,
// Ctrl-Space, Ctrl-Tab). Binding syntax: see lib/keys.ts (`mod` = Cmd on macOS, Ctrl elsewhere).

export const KEY_PALETTE = 'mod+k';
export const KEY_COMPOSER = 'mod+j';
/** Best effort: browsers keep Cmd-N for a new window in a normal tab (plan 4.2); works where delivered. */
export const KEY_COMPOSER_ALT = 'mod+n';
export const KEY_SIDEBAR = 'mod+b';
export const KEY_ESC = 'esc';
export const KEY_UP = 'up';
export const KEY_DOWN = 'down';
export const KEY_LEFT = 'left';
export const KEY_RIGHT = 'right';
export const KEY_ENTER = 'enter';
/** Push-to-talk anywhere. Launchers (Raycast, ChatGPT) may claim Option-Space system-wide: use the mic button then. */
export const KEY_PTT_ANYWHERE = 'alt+space';
/** Push-to-talk when focus is not in a text field or on a button. */
export const KEY_PTT = 'space';
/** Composer history recall (kept from v0.1). */
export const KEY_RECALL_OLDER = 'alt+up';
export const KEY_RECALL_NEWER = 'alt+down';

export type ShortcutGroup = 'Everywhere' | 'Lists and the stream' | 'Composer' | 'Voice';
export interface Shortcut { keys: string; description: string; group: ShortcutGroup }

export const SHORTCUTS: readonly Shortcut[] = [
  { group: 'Everywhere', keys: 'Cmd-K (Ctrl-K)', description: 'Search and commands' },
  { group: 'Everywhere', keys: 'Cmd-J (Ctrl-J)', description: 'New capture: focus the composer' },
  { group: 'Everywhere', keys: 'Cmd-N (Ctrl-N)', description: 'Same, where the browser delivers it (not in a normal tab)' },
  { group: 'Everywhere', keys: 'Cmd-B (Ctrl-B)', description: 'Show or hide the sidebar' },
  { group: 'Everywhere', keys: 'Esc', description: 'Close the top dialog; cancel a recording; leave a field (it saves); close the document; focus the composer' },
  { group: 'Everywhere', keys: 'Tab / Shift-Tab', description: 'Move between lists, fields and buttons' },
  { group: 'Everywhere', keys: 'Any letter', description: 'Typing outside a field goes to the composer' },
  { group: 'Lists and the stream', keys: '↑ / ↓', description: 'Pick a row (not while a text field has focus)' },
  { group: 'Lists and the stream', keys: '← / →', description: "Pick one of the row's action chips" },
  { group: 'Lists and the stream', keys: 'Enter', description: 'Run the highlighted chip (default: the first action)' },
  { group: 'Composer', keys: 'Enter / Shift-Enter', description: 'Send / new line' },
  { group: 'Composer', keys: '↑ (empty composer)', description: 'Move into the stream at the newest item' },
  { group: 'Composer', keys: 'Option-↑ / Option-↓', description: 'Recall earlier or later texts; what you typed is kept' },
  { group: 'Voice', keys: 'Option-Space (hold)', description: 'Push-to-talk anywhere' },
  { group: 'Voice', keys: 'Space (hold)', description: 'Push-to-talk when focus is not in a text field or on a button' },
] as const;

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['Everywhere', 'Lists and the stream', 'Composer', 'Voice'];
