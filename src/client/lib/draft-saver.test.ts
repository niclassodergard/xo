import { describe, expect, it, vi } from 'vitest';
import { createDraftSaver } from './draft-saver.ts';

describe('createDraftSaver', () => {
  it('stays dirty after a failed save and saves on the next attempt', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('401')).mockResolvedValueOnce(undefined);
    const failed = vi.fn(), saved = vi.fn();
    const s = createDraftSaver('old', () => onSave, { onFailed: failed, onSaved: saved });
    expect(await s.save('new')).toBe(false);
    expect(s.saved()).toBe('old');
    expect(s.isDirty('new')).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(await s.save('new')).toBe(true);
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(s.saved()).toBe('new');
    expect(s.isDirty('new')).toBe(false);
    expect(saved).toHaveBeenCalledWith('new');
  });

  it('treats a synchronous onSave as success and skips unchanged values', async () => {
    const onSave = vi.fn();
    const s = createDraftSaver('a', () => onSave);
    expect(await s.save('a')).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    expect(await s.save('b')).toBe(true);
    expect(onSave).toHaveBeenCalledWith('b');
  });

  it('treats a synchronous throw as a failed save', async () => {
    const s = createDraftSaver('a', () => () => { throw new Error('x'); });
    expect(await s.save('b')).toBe(false);
    expect(s.isDirty('b')).toBe(true);
  });

  it('does not save the same value twice while a save is in flight', async () => {
    let release!: () => void;
    const onSave = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const s = createDraftSaver('a', () => onSave);
    const p1 = s.save('b'), p2 = s.save('b');
    expect(onSave).toHaveBeenCalledTimes(1);
    release();
    expect(await p1).toBe(true);
    expect(await p2).toBe(true);
  });
});
