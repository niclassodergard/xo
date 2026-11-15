import { describe, expect, it } from 'vitest';
import { FakeClassifier, FakeTranscriber } from './fake.ts';
import { LlmError } from './types.ts';


const c = new FakeClassifier();
const run = (text: string) => c.classify({ text, people: [], now: '2026-01-01T00:00:00Z' });

describe('FakeClassifier', () => {
  it('?? is low-confidence note', async () => {
    expect(await run('what is this ??')).toMatchObject({ kind: 'note', confidence: 0.1 });
  });
  it('todo: is an action', async () => {
    expect(await run('todo: call the bank')).toMatchObject({ kind: 'action', confidence: 0.95, owner: 'me' });
  });
  it('agenda: is an agenda item', async () => {
    expect(await run('agenda: hiring')).toMatchObject({ kind: 'agenda', confidence: 0.95 });
  });
  it('!!fail throws LlmError', async () => {
    await expect(run('boom !!fail')).rejects.toBeInstanceOf(LlmError);
    await expect(run('boom !!fail')).rejects.toMatchObject({ name: 'LlmError' });
  });
  it('defaults to a confident note', async () => {
    expect(await run('just a thought')).toEqual({ kind: 'note', confidence: 0.95, personName: null, owner: 'me' });
  });
  it('extracts an uppercase-initial name after "with "', async () => {
    expect((await run('lunch with Anna tomorrow')).personName).toBe('Anna');
    expect((await run('lunch with anna tomorrow')).personName).toBeNull();
    expect((await run('coffee with the team')).personName).toBeNull();
    expect((await run('lunch with Åsa')).personName).toBe('Åsa');
    expect((await run('nothing here')).personName).toBeNull();
  });
});

describe('FakeTranscriber', () => {
  it('defaults to "open Anna"', async () => {
    expect(await new FakeTranscriber().transcribe(Buffer.alloc(0), 'webm')).toEqual({ text: 'open Anna' });
  });
  it('returns the configured text', async () => {
    expect(await new FakeTranscriber('go to actions').transcribe(Buffer.alloc(0), 'wav')).toEqual({ text: 'go to actions' });
  });
});
