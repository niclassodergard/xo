import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commandList, createKeyEngine, eventToken, filterCommands, focusContext, fuzzyScore, installKeyListeners, NO_FOCUS,
  parseSpec, registerCommand, shouldTypeToComposer, keystrokeMark, typedSince,
} from './keys.ts';
import type { FocusContext, KeyLike } from './keys.ts';
import { registerFocusTarget, resetFocusTargets } from './focus.ts';

const k = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, ...extra });
const ctx = (extra: Partial<FocusContext> = {}): FocusContext => ({ ...NO_FOCUS, ...extra });

describe('eventToken', () => {
  it('maps plain, shifted and named keys', () => {
    expect(eventToken(k('j'))).toBe('j');
    expect(eventToken(k('G', { shiftKey: true }))).toBe('shift+g');
    expect(eventToken(k('?', { shiftKey: true }))).toBe('?');
    expect(eventToken(k('Escape'))).toBe('esc');
    expect(eventToken(k('Enter'))).toBe('enter');
    expect(eventToken(k('Enter', { shiftKey: true }))).toBe('shift+enter');
    expect(eventToken(k('Tab', { shiftKey: true }))).toBe('shift+tab');
    expect(eventToken(k('ArrowDown'))).toBe('down');
  });
  it('maps Cmd and Ctrl to mod, and Space incl. Option-Space', () => {
    expect(eventToken(k('k', { ctrlKey: true }))).toBe('mod+k');
    expect(eventToken(k('k', { metaKey: true }))).toBe('mod+k');
    expect(eventToken(k(' ', { code: 'Space' }))).toBe('space');
    expect(eventToken(k(' ', { code: 'Space', altKey: true }))).toBe('alt+space');
    expect(eventToken(k('ArrowUp', { altKey: true }))).toBe('alt+up');
  });
  it('ignores modifier-only presses', () => {
    expect(eventToken(k('Shift', { shiftKey: true }))).toBeNull();
    expect(eventToken(k('Meta'))).toBeNull();
  });
});

describe('parseSpec', () => {
  it('parses single keys and aliases, with mod as the one Cmd/Ctrl token', () => {
    expect(parseSpec('mod+k')).toBe('mod+k');
    expect(parseSpec('Ctrl+K')).toBe('mod+k');
    expect(parseSpec('cmd+j')).toBe('mod+j');
    expect(parseSpec('alt+space')).toBe('alt+space');
    expect(parseSpec('escape')).toBe('esc');
    expect(parseSpec('G')).toBe('shift+g');
    expect(parseSpec('?')).toBe('?');
  });
  it('rejects empty specs, unknown modifiers and key sequences', () => {
    expect(() => parseSpec('  ')).toThrow();
    expect(() => parseSpec('hyper+x')).toThrow();
    expect(() => parseSpec('g c')).toThrow(/sequences/);
  });
});

describe('engine matching', () => {
  it('runs a binding and reports unhandled keys', () => {
    const e = createKeyEngine();
    const run = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'mod+j', run }] });
    expect(e.handle(k('j', { metaKey: true }), NO_FOCUS)).toBe(true);
    expect(e.handle(k('j', { ctrlKey: true }), NO_FOCUS)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(e.handle(k('j'), NO_FOCUS)).toBe(false);
  });

  it('removing a layer removes its bindings', () => {
    const e = createKeyEngine();
    const run = vi.fn();
    const off = e.addLayer({ scope: 'global', bindings: [{ spec: 'esc', run }] });
    off();
    expect(e.handle(k('Escape'), NO_FOCUS)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('the newest layer of the same scope wins; panel and stream beat global', () => {
    const e = createKeyEngine();
    const a = vi.fn(), b = vi.fn(), g = vi.fn(), p = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'down', run: g }, { spec: 'enter', run: a }] });
    e.addLayer({ scope: 'global', bindings: [{ spec: 'enter', run: b }] });
    e.addLayer({ scope: 'panel', bindings: [{ spec: 'down', run: p }] });
    e.handle(k('Enter'), NO_FOCUS);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).not.toHaveBeenCalled();
    e.handle(k('ArrowDown'), ctx({ region: 'panel' }));
    expect(p).toHaveBeenCalledTimes(1);
    expect(g).not.toHaveBeenCalled();
  });

  it('ignores composing keys (isComposing or keyCode 229)', () => {
    const e = createKeyEngine();
    const run = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'mod+k', run }] });
    expect(e.handle(k('k', { metaKey: true, isComposing: true }), NO_FOCUS)).toBe(false);
    expect(e.handle(k('k', { metaKey: true, keyCode: 229 }), NO_FOCUS)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('rule 1: a modal layer blocks everything below it', () => {
  it('only modal bindings match, except global Esc and Cmd-K', () => {
    const e = createKeyEngine();
    const gEsc = vi.fn(), gK = vi.fn(), gJ = vi.fn(), pDown = vi.fn(), mEnter = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'esc', run: gEsc }, { spec: 'mod+k', run: gK }, { spec: 'mod+j', run: gJ }] });
    e.addLayer({ scope: 'panel', bindings: [{ spec: 'down', run: pDown }] });
    const off = e.addLayer({ scope: 'modal', bindings: [{ spec: 'enter', run: mEnter }] });
    expect(e.modalOpen()).toBe(true);
    expect(e.handle(k('j', { metaKey: true }), NO_FOCUS)).toBe(false);
    expect(e.handle(k('ArrowDown'), ctx({ region: 'panel' }))).toBe(false);
    expect(gJ).not.toHaveBeenCalled();
    expect(pDown).not.toHaveBeenCalled();
    expect(e.handle(k('Enter'), NO_FOCUS)).toBe(true);
    expect(mEnter).toHaveBeenCalledTimes(1);
    expect(e.handle(k('Escape'), NO_FOCUS)).toBe(true);
    expect(e.handle(k('k', { metaKey: true }), NO_FOCUS)).toBe(true);
    expect(gEsc).toHaveBeenCalledTimes(1);
    expect(gK).toHaveBeenCalledTimes(1);
    off();
    expect(e.modalOpen()).toBe(false);
    expect(e.handle(k('j', { metaKey: true }), NO_FOCUS)).toBe(true);
  });

  it('a panel-scope Esc or Cmd-K does not pass a modal (only the global layer does)', () => {
    const e = createKeyEngine();
    const pEsc = vi.fn(), pK = vi.fn(), gEsc = vi.fn();
    e.addLayer({ scope: 'panel', bindings: [{ spec: 'esc', run: pEsc }, { spec: 'mod+k', run: pK }] });
    e.addLayer({ scope: 'modal', bindings: [] }); // e.g. Login: no bindings of its own
    const inPanel = ctx({ region: 'panel' });
    expect(e.handle(k('Escape'), inPanel)).toBe(false);
    expect(e.handle(k('k', { metaKey: true }), inPanel)).toBe(false);
    expect(pEsc).not.toHaveBeenCalled();
    expect(pK).not.toHaveBeenCalled();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'esc', run: gEsc }] });
    expect(e.handle(k('Escape'), inPanel)).toBe(true);
    expect(gEsc).toHaveBeenCalledTimes(1);
    expect(pEsc).not.toHaveBeenCalled();
  });
});

describe('rule 2: a text entry owns plain keys', () => {
  it('arrows, Enter, Space and printable keys do not fire; mod/alt combinations and Esc do', () => {
    const e = createKeyEngine();
    const fired: string[] = [];
    const bind = (spec: string) => ({ spec, run: () => { fired.push(spec); } });
    e.addLayer({
      scope: 'global',
      bindings: ['up', 'down', 'left', 'right', 'enter', 'space', 'j', 'shift+enter', 'esc', 'mod+k', 'alt+space', 'alt+up'].map(bind),
    });
    const typing = ctx({ textEntry: true });
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'j']) {
      expect(e.handle(k(key), typing)).toBe(false);
    }
    expect(e.handle(k(' ', { code: 'Space' }), typing)).toBe(false);
    expect(e.handle(k('Enter', { shiftKey: true }), typing)).toBe(false);
    expect(fired).toEqual([]);
    expect(e.handle(k('Escape'), typing)).toBe(true);
    expect(e.handle(k('k', { metaKey: true }), typing)).toBe(true);
    expect(e.handle(k(' ', { code: 'Space', altKey: true }), typing)).toBe(true);
    expect(e.handle(k('ArrowUp', { altKey: true }), typing)).toBe(true);
    expect(fired).toEqual(['esc', 'mod+k', 'alt+space', 'alt+up']);
  });

  it('the same keys fire when no text entry has focus', () => {
    const e = createKeyEngine();
    const run = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'down', run }] });
    expect(e.handle(k('ArrowDown'), NO_FOCUS)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('rule 3: regions', () => {
  it('panel bindings fire only inside the panel, stream bindings only inside the stream', () => {
    const e = createKeyEngine();
    const p = vi.fn(), s = vi.fn(), g = vi.fn();
    e.addLayer({ scope: 'panel', bindings: [{ spec: 'down', run: p }] });
    e.addLayer({ scope: 'stream', bindings: [{ spec: 'down', run: s }] });
    e.addLayer({ scope: 'global', bindings: [{ spec: 'up', run: g }] });
    expect(e.handle(k('ArrowDown'), ctx({ region: null }))).toBe(false);
    expect(e.handle(k('ArrowDown'), ctx({ region: 'sidebar' }))).toBe(false);
    expect(e.handle(k('ArrowDown'), ctx({ region: 'panel' }))).toBe(true);
    expect(p).toHaveBeenCalledTimes(1);
    expect(s).not.toHaveBeenCalled();
    expect(e.handle(k('ArrowDown'), ctx({ region: 'stream' }))).toBe(true);
    expect(s).toHaveBeenCalledTimes(1);
    expect(p).toHaveBeenCalledTimes(1);
    expect(e.handle(k('ArrowUp'), ctx({ region: null }))).toBe(true); // global fires anywhere
  });
});

describe('Enter auto-repeat', () => {
  it('never runs a binding, but the first press does', () => {
    const e = createKeyEngine();
    const run = vi.fn();
    e.addLayer({ scope: 'global', bindings: [{ spec: 'enter', run }, { spec: 'down', run }] });
    expect(e.handle(k('Enter', { repeat: true }), NO_FOCUS)).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(e.handle(k('Enter'), NO_FOCUS)).toBe(true);
    expect(e.handle(k('ArrowDown', { repeat: true }), NO_FOCUS)).toBe(true); // arrows may repeat
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('keystroke marker', () => {
  class FakeWindow extends EventTarget {
    document = Object.assign(new EventTarget(), { activeElement: null as unknown });
  }
  it('counts real key presses (not bare modifiers) so async results can tell the user typed', () => {
    const win = new FakeWindow();
    const off = installKeyListeners(win as unknown as Window);
    const mark = keystrokeMark();
    expect(typedSince(mark)).toBe(false);
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Shift' }));
    expect(typedSince(mark)).toBe(false);
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'x' }));
    expect(typedSince(mark)).toBe(true);
    expect(typedSince(keystrokeMark())).toBe(false);
    off();
  });
});

describe('rule 4: native activation', () => {
  it('a focused button, link or checkbox keeps Enter and Space, but not other keys', () => {
    const e = createKeyEngine();
    const fired: string[] = [];
    e.addLayer({ scope: 'global', bindings: ['enter', 'space', 'down', 'alt+space'].map((spec) => ({ spec, run: () => { fired.push(spec); } })) });
    const onButton = ctx({ nativeActivation: true });
    expect(e.handle(k('Enter'), onButton)).toBe(false);
    expect(e.handle(k(' ', { code: 'Space' }), onButton)).toBe(false);
    expect(fired).toEqual([]);
    expect(e.handle(k('ArrowDown'), onButton)).toBe(true);
    expect(e.handle(k(' ', { code: 'Space', altKey: true }), onButton)).toBe(true);
    expect(fired).toEqual(['down', 'alt+space']);
  });
});

describe('rule 5: type-to-composer decision', () => {
  it('a printable key with no text entry and no modal goes to the composer', () => {
    expect(shouldTypeToComposer(k('a'), NO_FOCUS, false)).toBe(true);
    expect(shouldTypeToComposer(k('å'), NO_FOCUS, false)).toBe(true);
    expect(shouldTypeToComposer(k('?', { shiftKey: true }), NO_FOCUS, false)).toBe(true);
    expect(shouldTypeToComposer(k('a'), ctx({ nativeActivation: true }), false)).toBe(true);
  });
  it('not in a text entry, behind a modal, with mod/alt, or for non-printing keys', () => {
    expect(shouldTypeToComposer(k('a'), ctx({ textEntry: true }), false)).toBe(false);
    expect(shouldTypeToComposer(k('a'), NO_FOCUS, true)).toBe(false);
    expect(shouldTypeToComposer(k('a', { metaKey: true }), NO_FOCUS, false)).toBe(false);
    expect(shouldTypeToComposer(k('a', { ctrlKey: true }), NO_FOCUS, false)).toBe(false);
    expect(shouldTypeToComposer(k('@', { altKey: true }), NO_FOCUS, false)).toBe(true); // Option-2 on a Swedish Mac
    expect(shouldTypeToComposer(k('@', { altKey: true, metaKey: true }), NO_FOCUS, false)).toBe(false);
    for (const key of ['Enter', 'Escape', 'ArrowDown', 'Tab', 'Shift', 'Backspace', 'F5', ' ', 'Dead']) {
      expect(shouldTypeToComposer(k(key), NO_FOCUS, false)).toBe(false);
    }
    expect(shouldTypeToComposer(k('a', { isComposing: true }), NO_FOCUS, false)).toBe(false);
  });
});

describe('modalOpen', () => {
  it('is true exactly while a modal layer exists', () => {
    const e = createKeyEngine();
    expect(e.modalOpen()).toBe(false);
    const g = e.addLayer({ scope: 'global', bindings: [] });
    expect(e.modalOpen()).toBe(false);
    const m = e.addLayer({ scope: 'modal', bindings: [] });
    expect(e.modalOpen()).toBe(true);
    m();
    expect(e.modalOpen()).toBe(false);
    g();
  });
});

describe('focusContext', () => {
  it('reads the target tag and tolerates objects that are not elements', () => {
    expect(focusContext(null, null)).toEqual(NO_FOCUS);
    expect(focusContext({} as Element, { tagName: 'BUTTON' } as unknown as EventTarget).nativeActivation).toBe(true);
    expect(focusContext(null, { tagName: 'A' } as unknown as EventTarget).nativeActivation).toBe(true);
    expect(focusContext(null, { tagName: 'INPUT', type: 'checkbox' } as unknown as EventTarget).nativeActivation).toBe(true);
    expect(focusContext(null, { tagName: 'INPUT', type: 'text' } as unknown as EventTarget).nativeActivation).toBe(false);
    expect(focusContext(null, { tagName: 'DIV' } as unknown as EventTarget).nativeActivation).toBe(false);
  });
});

describe('installKeyListeners: type-to-composer wiring', () => {
  class FakeWindow extends EventTarget {
    document = Object.assign(new EventTarget(), { activeElement: null as unknown });
  }
  afterEach(() => { resetFocusTargets(); });

  it('focuses the composer synchronously on a printable key and does not prevent the key', () => {
    const win = new FakeWindow();
    const focus = vi.fn();
    registerFocusTarget('composer', () => ({ focus, isConnected: true } as unknown as HTMLElement));
    const off = installKeyListeners(win as unknown as Window);
    const ev = Object.assign(new Event('keydown', { cancelable: true }), { key: 'h' });
    win.dispatchEvent(ev);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(false);
    off();
  });

  it('is a no-op when the composer is not rendered, and does not queue a later focus', () => {
    const win = new FakeWindow();
    const off = installKeyListeners(win as unknown as Window);
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'h' }));
    const focus = vi.fn();
    registerFocusTarget('composer', () => ({ focus, isConnected: true } as unknown as HTMLElement));
    expect(focus).not.toHaveBeenCalled();
    off();
  });
});

describe('palette filter and command registry', () => {
  it('fuzzyScore ranks substring and prefix matches and rejects non-matches', () => {
    expect(fuzzyScore('xyz', 'Go to Notes')).toBeNull();
    expect(fuzzyScore('notes', 'Go to Notes')!).toBeGreaterThan(fuzzyScore('gts', 'Go to Notes')!);
    expect(fuzzyScore('', 'anything')).toBe(0);
  });
  it('filterCommands matches titles and keywords, best first, stable for ties', () => {
    const cmds = [
      { id: 'a', title: 'Go to Actions', run: () => {}, keywords: ['todo'] },
      { id: 'b', title: 'Go to Notes', run: () => {} },
      { id: 'c', title: 'Log out', run: () => {}, keywords: ['sign out'] },
    ];
    expect(filterCommands('notes', cmds).map((c) => c.id)).toEqual(['b']);
    expect(filterCommands('todo', cmds).map((c) => c.id)).toEqual(['a']);
    expect(filterCommands('sign', cmds).map((c) => c.id)).toEqual(['c']);
    expect(filterCommands('', cmds).map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(filterCommands('zzzz', cmds)).toEqual([]);
  });
  it('registerCommand replaces by id and unregisters', () => {
    const off = registerCommand({ id: 't.x', title: 'One', run: () => {} });
    registerCommand({ id: 't.x', title: 'Two', run: () => {} });
    expect(commandList.value.filter((c) => c.id === 't.x').map((c) => c.title)).toEqual(['Two']);
    off(); // the first registration was replaced: its off() must not remove the newer one
    expect(commandList.value.some((c) => c.id === 't.x')).toBe(true);
    commandList.value = commandList.value.filter((c) => c.id !== 't.x');
  });
});
