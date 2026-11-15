import { describe, expect, it } from 'vitest';
import { FakeAnswerer, FakeClassifier, FakeTranscriber } from './fake.ts';
import { LlmError } from './types.ts';


const c = new FakeClassifier();
const run = (text: string) => c.classify({ text, people: [], projects: [], now: '2026-01-01T00:00:00Z' });

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
  it('a single trailing ? is a confident question; ?? stays unsure and todo:/agenda: win', async () => {
    expect(await run('what did I promise Anna?')).toMatchObject({ kind: 'question', confidence: 0.95 });
    expect(await run('what did I promise Anna?  ')).toMatchObject({ kind: 'question' });
    expect(await run('what is this ??')).toMatchObject({ kind: 'note', confidence: 0.1 });
    expect(await run('really?? what')).toMatchObject({ confidence: 0.1 });
    expect(await run('todo: is it done?')).toMatchObject({ kind: 'action' });
    expect(await run('no question mark')).toMatchObject({ kind: 'note' });
  });
  it('!!fail throws LlmError', async () => {
    await expect(run('boom !!fail')).rejects.toBeInstanceOf(LlmError);
    await expect(run('boom !!fail')).rejects.toMatchObject({ name: 'LlmError' });
  });
  it('defaults to a confident note', async () => {
    expect(await run('just a thought')).toEqual({ kind: 'note', confidence: 0.95, personName: null, projectName: null, owner: 'me' });
  });
  it('extracts an uppercase-initial name after "with "', async () => {
    expect((await run('lunch with Anna tomorrow')).personName).toBe('Anna');
    expect((await run('lunch with anna tomorrow')).personName).toBeNull();
    expect((await run('coffee with the team')).personName).toBeNull();
    expect((await run('lunch with Åsa')).personName).toBe('Åsa');
    expect((await run('nothing here')).personName).toBeNull();
  });
});

describe('FakeClassifier project names', () => {
  it('takes the capitalised word after "project "', async () => {
    expect((await run('todo: slides for project Apollo')).projectName).toBe('Apollo');
    expect((await run('note on project Åre-resa today')).projectName).toBe('Åre-resa');
  });
  it('is null without a capitalised word after "project "', async () => {
    expect((await run('the project apollo')).projectName).toBeNull();
    expect((await run('a project plan')).projectName).toBeNull();
    expect((await run('nothing here')).projectName).toBeNull();
    expect((await run('subproject Apollo')).projectName).toBeNull();
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

describe('FakeAnswerer', () => {
  const ex = [1, 2, 3].map((i) => ({ ref: `note:${i}`, title: `T${i}`, text: `x${i}` }));
  it('lists the titles and cites the first two refs', async () => {
    expect(await new FakeAnswerer().answer({ question: 'q', now: 'n', excerpts: ex })).toEqual({
      answer: 'Found 3 item(s): T1, T2, T3', cited: ['note:1', 'note:2'],
    });
  });
  it('!!fail throws LlmError', async () => {
    await expect(new FakeAnswerer().answer({ question: 'q !!fail', now: 'n', excerpts: ex })).rejects.toBeInstanceOf(LlmError);
  });
});
