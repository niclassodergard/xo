import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusTarget, registerFocusTarget, resetFocusTargets } from './focus.ts';

const el = () => {
  const focus = vi.fn();
  return { focus, node: { focus, isConnected: true } as unknown as HTMLElement };
};

beforeEach(() => { vi.useFakeTimers(); resetFocusTargets(); });
afterEach(() => { vi.useRealTimers(); });

describe('focusTarget', () => {
  it('focuses synchronously when the target is registered', () => {
    const a = el();
    registerFocusTarget('composer', () => a.node);
    expect(focusTarget('composer')).toBe(true);
    expect(a.focus).toHaveBeenCalledTimes(1);
  });

  it('queues for up to 1 s when the target is not rendered yet, then focuses on registration', () => {
    expect(focusTarget('panel')).toBe(false);
    vi.advanceTimersByTime(900);
    const a = el();
    registerFocusTarget('panel', () => a.node);
    expect(a.focus).toHaveBeenCalledTimes(1);
  });

  it('a queued request expires after 1 s', () => {
    focusTarget('panel');
    vi.advanceTimersByTime(1100);
    const a = el();
    registerFocusTarget('panel', () => a.node);
    expect(a.focus).not.toHaveBeenCalled();
  });

  it('queue: false never queues', () => {
    expect(focusTarget('composer', { queue: false })).toBe(false);
    const a = el();
    registerFocusTarget('composer', () => a.node);
    expect(a.focus).not.toHaveBeenCalled();
  });

  it('a queued request runs once, and the unregister function removes the target', () => {
    focusTarget('panel');
    const a = el();
    const off = registerFocusTarget('panel', () => a.node);
    expect(a.focus).toHaveBeenCalledTimes(1);
    off();
    expect(focusTarget('panel', { queue: false })).toBe(false);
    expect(a.focus).toHaveBeenCalledTimes(1);
  });

  it('a stale unregister does not remove a newer registration', () => {
    const a = el(), b = el();
    const offA = registerFocusTarget('composer', () => a.node);
    registerFocusTarget('composer', () => b.node);
    offA();
    expect(focusTarget('composer')).toBe(true);
    expect(b.focus).toHaveBeenCalledTimes(1);
    expect(a.focus).not.toHaveBeenCalled();
  });

  it('a registered target whose element is gone or not yet there is queued, not focused', () => {
    registerFocusTarget('panel', () => null);
    expect(focusTarget('panel')).toBe(false);
    const gone = { focus: vi.fn(), isConnected: false } as unknown as HTMLElement;
    resetFocusTargets();
    registerFocusTarget('panel', () => gone);
    expect(focusTarget('panel', { queue: false })).toBe(false);
    expect(gone.focus).not.toHaveBeenCalled();
  });
});
