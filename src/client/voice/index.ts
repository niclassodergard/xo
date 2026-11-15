// Stub: step 10 replaces this with push-to-talk, dictation and voice commands.
//
// Contract with the shell (app.tsx):
// - initVoice() is called only while a session exists and again after re-login. It may return a
//   cleanup function; the shell calls it when the session ends, so voice bindings are never live
//   on the Login screen.
// - Key bindings run on key DOWN only (useKeys / engine.addLayer). For hold-to-talk, start on the
//   first keydown (ignore auto-repeat: check `e.repeat`) and stop on release by subscribing with
//   `onKeyUp(fn)` from lib/keys.ts (returns an unsubscribe function; fn receives the KeyboardEvent).
// - Mouse clicks blur buttons/links (installKeyListeners), so a focused mic button does not eat Space.
export function initVoice(): void | (() => void) {}
