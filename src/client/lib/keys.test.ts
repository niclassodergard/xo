import { describe, expect, it, vi } from 'vitest';
import {
  createKeyEngine, eventToken, filterCommands, fuzzyScore, parseSpec, registerCommand, commandList,
} from './keys.ts';
import type { KeyLike } from './keys.ts';

const k = (key: string, extra: Partial<KeyLike> = {}): KeyLike => ({ key, ...extra });

function setup() {
  let t = 0;
  const engine = createKeyEngine(() => t);
  return { engine, advance: (ms: number) => { t += ms; } };
}

describe('eventToken', () => {
  it('maps plain, shifted and named keys', () => {
    expect(eventToken(k('j'))).toBe('j');
    expect(eventToken(k('G', { shiftKey: true }))).toBe('shift+g');
    expect(eventToken(k('g', { shiftKey: false }))).toBe('g');
    expect(eventToken(k('?', { shiftKey: true }))).toBe('?');
    expect(eventToken(k(':', { shiftKey: true }))).toBe(':');
    expect(eventToken(k('Escape'))).toBe('esc');
    expect(eventToken(k('Enter'))).toBe('enter');
    expect(eventToken(k('Tab', { shiftKey: true }))).toBe('shift+tab');
    expect(eventToken(k('ArrowDown'))).toBe('down');
  });
  it('handles modifiers, Cmd as Ctrl, and Space incl. Alt+Space', () => {
    expect(eventToken(k('k', { ctrlKey: true }))).toBe('ctrl+k');
    expect(eventToken(k('k', { metaKey: true }))).toBe('ctrl+k');
    expect(eventToken(k(' ', { code: 'Space' }))).toBe('space');
    expect(eventToken(k(' ', { code: 'Space', altKey: true }))).toBe('alt+space');
  });
  it('ignores modifier-only presses', () => {
    expect(eventToken(k('Shift', { shiftKey: true }))).toBeNull();
    expect(eventToken(k('Control'))).toBeNull();
  });
});

describe('parseSpec', () => {
  it('parses singles, sequences and aliases', () => {
    expect(parseSpec('j')).toEqual(['j']);
    expect(parseSpec('g c')).toEqual(['g', 'c']);
    expect(parseSpec('shift+g')).toEqual(['shift+g']);
    expect(parseSpec('G')).toEqual(['shift+g']);
    expect(parseSpec('Ctrl+K')).toEqual(['ctrl+k']);
    expect(parseSpec('escape')).toEqual(['esc']);
    expect(parseSpec('?')).toEqual(['?']);
  });
  it('rejects empty specs and unknown modifiers', () => {
    expect(() => parseSpec('  ')).toThrow();
    expect(() => parseSpec('hyper+x')).toThrow();
  });
});

describe('engine', () => {
  it('runs single keys and reports unhandled keys', () => {
    const { engine } = setup();
    const run = vi.fn();
    engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'j', run }] });
    expect(engine.handle(k('j'), 'normal')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(engine.handle(k('x'), 'normal')).toBe(false);
  });

  it('matches modifier combos', () => {
    const { engine } = setup();
    const run = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'shift+g', run }] });
    expect(engine.handle(k('g'), 'normal')).toBe(false);
    expect(engine.handle(k('G', { shiftKey: true }), 'normal')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('matches sequences and swallows the prefix', () => {
    const { engine } = setup();
    const gc = vi.fn(), ga = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: gc }, { spec: 'g a', run: ga }] });
    expect(engine.handle(k('g'), 'normal')).toBe(true);
    expect(gc).not.toHaveBeenCalled();
    expect(engine.handle(k('c'), 'normal')).toBe(true);
    expect(gc).toHaveBeenCalledTimes(1);
    engine.handle(k('g'), 'normal');
    engine.handle(k('a'), 'normal');
    expect(ga).toHaveBeenCalledTimes(1);
  });

  it('drops a sequence after the 1 s timeout', () => {
    const { engine, advance } = setup();
    const gc = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: gc }] });
    engine.handle(k('g'), 'normal');
    advance(1001);
    expect(engine.handle(k('c'), 'normal')).toBe(false);
    expect(gc).not.toHaveBeenCalled();
    engine.handle(k('g'), 'normal');
    advance(999);
    engine.handle(k('c'), 'normal');
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('restarts the sequence when a wrong second key is itself a prefix', () => {
    const { engine } = setup();
    const gc = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: gc }] });
    engine.handle(k('g'), 'normal');
    expect(engine.handle(k('g'), 'normal')).toBe(true); // g g is not bound, but g starts over
    engine.handle(k('c'), 'normal');
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('lets view bindings win over list and global ones', () => {
    const { engine } = setup();
    const g = vi.fn(), l = vi.fn(), v = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'j', run: g }] });
    engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'j', run: v }] });
    engine.addLayer({ scope: 'list', modes: ['normal'], bindings: [{ spec: 'j', run: l }] });
    engine.handle(k('j'), 'normal');
    expect(v).toHaveBeenCalledTimes(1);
    expect(l).not.toHaveBeenCalled();
    expect(g).not.toHaveBeenCalled();
  });

  it('falls through to global when a view has only a longer sequence', () => {
    const { engine } = setup();
    const gc = vi.fn(), gg = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: gc }] });
    engine.addLayer({ scope: 'list', modes: ['normal'], bindings: [{ spec: 'g g', run: gg }] });
    engine.handle(k('g'), 'normal');
    engine.handle(k('c'), 'normal');
    expect(gc).toHaveBeenCalledTimes(1);
    expect(gg).not.toHaveBeenCalled();
  });

  it('removes a layer when unregistered', () => {
    const { engine } = setup();
    const run = vi.fn();
    const off = engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'j', run }] });
    off();
    expect(engine.handle(k('j'), 'normal')).toBe(false);
  });

  it('ignores everything but Esc, Ctrl-K and Alt-Space while typing or in the palette', () => {
    const { engine } = setup();
    const j = vi.fn(), esc = vi.fn(), ck = vi.fn(), as = vi.fn();
    engine.addLayer({
      scope: 'view', modes: ['normal', 'insert', 'command'],
      bindings: [{ spec: 'j', run: j }, { spec: 'esc', run: esc }, { spec: 'ctrl+k', run: ck }, { spec: 'alt+space', run: as }],
    });
    for (const m of ['insert', 'command'] as const) {
      expect(engine.handle(k('j'), m)).toBe(false);
      expect(engine.handle(k('Escape'), m)).toBe(true);
      expect(engine.handle(k('k', { ctrlKey: true }), m)).toBe(true);
      expect(engine.handle(k(' ', { code: 'Space', altKey: true }), m)).toBe(true);
    }
    expect(j).not.toHaveBeenCalled();
    expect(esc).toHaveBeenCalledTimes(2);
  });

  it('only runs bindings registered for the current mode', () => {
    const { engine } = setup();
    const run = vi.fn();
    engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'esc', run }] });
    expect(engine.handle(k('Escape'), 'insert')).toBe(false);
    expect(engine.handle(k('Escape'), 'normal')).toBe(true);
  });

  it('lists bindings with descriptions for the help overlay', () => {
    const { engine } = setup();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: '?', run: () => {}, description: 'help' }] });
    expect(engine.listBindings()).toEqual([{ spec: '?', description: 'help', scope: 'global' }]);
  });
});

describe('command registry and fuzzy filter', () => {
  it('registers, replaces by id and unregisters', () => {
    commandList.value = [];
    const off = registerCommand({ id: 'a', title: 'Alpha', run: () => {} });
    registerCommand({ id: 'a', title: 'Alpha 2', run: () => {} });
    expect(commandList.value.map((c) => c.title)).toEqual(['Alpha 2']);
    off(); // stale handle for the replaced command must not remove the new one
    expect(commandList.value).toHaveLength(1);
    commandList.value = [];
  });
  it('matches subsequences and ranks better matches first', () => {
    expect(fuzzyScore('xyz', 'Go to Chat')).toBeNull();
    const cmds = [
      { id: '1', title: 'Log out', run: () => {} },
      { id: '2', title: 'Go to Actions', run: () => {} },
      { id: '3', title: 'Start 1-1 with…', run: () => {}, keywords: ['meeting'] },
    ];
    expect(filterCommands('go', cmds)[0]?.id).toBe('2');
    expect(filterCommands('meet', cmds).map((c) => c.id)).toEqual(['3']);
    expect(filterCommands('', cmds)).toHaveLength(3);
    expect(filterCommands('zzz', cmds)).toEqual([]);
  });
});

describe('modal scope (regression: keys typed before an overlay has focus)', () => {
  it('blocks view, list and global bindings while a modal layer exists, in every mode', () => {
    const { engine } = setup();
    const nav = vi.fn(), undo = vi.fn(), listJ = vi.fn(), viewJ = vi.fn();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g n', run: nav }, { spec: 'u', run: undo }] });
    engine.addLayer({ scope: 'list', modes: ['normal'], bindings: [{ spec: 'j', run: listJ }] });
    engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'j', run: viewJ }] });
    const off = engine.addLayer({ scope: 'modal', modes: ['normal', 'insert', 'command'], bindings: [] });
    // Overlay open but its input not focused yet: the mode is still NORMAL.
    for (const key of ['g', 'n', 'u', 'j']) expect(engine.handle(k(key), 'normal')).toBe(false);
    expect(nav).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(listJ).not.toHaveBeenCalled();
    expect(viewJ).not.toHaveBeenCalled();
    off();
    engine.handle(k('u'), 'normal');
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('keeps Esc and Ctrl-K alive from the global layer, and lets the modal layer win for Esc', () => {
    const { engine } = setup();
    const gEsc = vi.fn(), gCk = vi.fn(), mEsc = vi.fn(), other = vi.fn();
    engine.addLayer({
      scope: 'global', modes: ['normal', 'insert', 'command'],
      bindings: [{ spec: 'esc', run: gEsc }, { spec: 'ctrl+k', run: gCk }, { spec: 'alt+space', run: other }],
    });
    expect(engine.handle(k('Escape'), 'normal')).toBe(true);
    expect(gEsc).toHaveBeenCalledTimes(1);
    engine.addLayer({ scope: 'modal', modes: ['normal', 'insert', 'command'], bindings: [{ spec: 'esc', run: mEsc }] });
    engine.handle(k('Escape'), 'insert');
    expect(mEsc).toHaveBeenCalledTimes(1);
    expect(gEsc).toHaveBeenCalledTimes(1);
    expect(engine.handle(k('k', { ctrlKey: true }), 'command')).toBe(true);
    expect(gCk).toHaveBeenCalledTimes(1);
    expect(engine.handle(k(' ', { code: 'Space', altKey: true }), 'normal')).toBe(false);
    expect(other).not.toHaveBeenCalled();
  });

  it('does not start a sequence behind a modal', () => {
    const { engine } = setup();
    engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: () => {} }] });
    engine.addLayer({ scope: 'modal', modes: ['normal'], bindings: [] });
    expect(engine.handle(k('g'), 'normal')).toBe(false);
  });
});

describe('always-on keys pass a modal only from the global layer', () => {
  it('a view-scope Esc or Ctrl-K does not run under a modal without its own Esc (e.g. Login)', () => {
    const { engine } = setup();
    const viewEsc = vi.fn(), viewCk = vi.fn(), globalEsc = vi.fn();
    engine.addLayer({ scope: 'view', modes: ['normal', 'insert'], bindings: [{ spec: 'esc', run: viewEsc }, { spec: 'ctrl+k', run: viewCk }] });
    engine.addLayer({ scope: 'modal', modes: ['normal', 'insert'], bindings: [] });
    expect(engine.handle(k('Escape'), 'insert')).toBe(false);
    expect(engine.handle(k('k', { ctrlKey: true }), 'insert')).toBe(false);
    expect(viewEsc).not.toHaveBeenCalled();
    expect(viewCk).not.toHaveBeenCalled();
    engine.addLayer({ scope: 'global', modes: ['normal', 'insert'], bindings: [{ spec: 'esc', run: globalEsc }] });
    expect(engine.handle(k('Escape'), 'insert')).toBe(true);
    expect(globalEsc).toHaveBeenCalledTimes(1);
    expect(viewEsc).not.toHaveBeenCalled();
  });
});

describe('IME and pending prefix', () => {
  it('ignores composing keys (isComposing or keyCode 229)', () => {
    const { engine } = setup();
    const run = vi.fn();
    engine.addLayer({ scope: 'view', modes: ['normal'], bindings: [{ spec: 'j', run }] });
    expect(engine.handle(k('j', { isComposing: true }), 'normal')).toBe(false);
    expect(engine.handle(k('j', { keyCode: 229 }), 'normal')).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('reports the pending prefix and clears it', () => {
    const seen: (string[] | null)[] = [];
    const eng = createKeyEngine(() => 0, (s) => seen.push(s));
    eng.addLayer({ scope: 'global', modes: ['normal'], bindings: [{ spec: 'g c', run: () => {} }] });
    eng.handle(k('g'), 'normal');
    expect(seen.at(-1)).toEqual(['g']);
    eng.handle(k('c'), 'normal');
    expect(seen.at(-1)).toBeNull();
  });
});


describe('modalOpen', () => {
  it('is true exactly while a modal layer exists (any mode set), not for other scopes', () => {
    const { engine } = setup();
    expect(engine.modalOpen()).toBe(false);
    const g = engine.addLayer({ scope: 'global', modes: ['normal'], bindings: [] });
    expect(engine.modalOpen()).toBe(false);
    const m = engine.addLayer({ scope: 'modal', modes: ['normal'], bindings: [] });
    expect(engine.modalOpen()).toBe(true);
    m();
    expect(engine.modalOpen()).toBe(false);
    g();
  });
});
