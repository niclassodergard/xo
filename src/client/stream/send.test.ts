import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capture } from '../../shared/types.ts';
import { api, ApiError } from '../lib/api.ts';
import { chatDraft, epoch, flashMessage, session, shellActive } from '../lib/store.ts';
import {
  askQuestion, askStates, reloadVersion, drainQueue, isTransient, landed, landedVersion, queuedTexts, sendDraft, sendQueue, sending, streamCaptures, submitText,
} from './send.ts';

function cap(id: number, text = 'x'): Capture {
  return {
    id, text, source: 'text', status: 'filed',
    draft: { kind: 'note', text, personId: null, personName: null, projectId: null, projectName: null, owner: 'me' },
    question: null, filed: [{ kind: 'note', id }], summary: '', classifiedBy: 'llm', deleted: false, createdAt: '2026-11-15T10:00:00.000Z', answer: null,
  };
}

beforeEach(() => {
  session.value = { csrfToken: 't' };
  shellActive.value = true;
});
afterEach(() => {
  vi.restoreAllMocks();
  session.value = null;
  shellActive.value = false; // logout: resets the queue
  chatDraft.value = '';
  flashMessage.value = null;
});

describe('session effects of the send module', () => {
  it('session null (a 401) clears the landed feed and the loaded captures', () => {
    landed.push(cap(1), epoch());
    streamCaptures.value = [cap(1)];
    expect(landed.size()).toBe(1);
    session.value = null;
    expect(landed.size()).toBe(0);
    expect(streamCaptures.value).toEqual([]);
  });

  it('a 401 keeps the queued texts (and shows nothing of them as sent)', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(401, 'unauthenticated', 'x'));
    await submitText('first', 'text');
    await submitText('second', 'voice');
    expect(sendQueue.texts()).toEqual(['first', 'second']);
    expect(queuedTexts.value).toEqual(['first', 'second']);
    session.value = null; // what api.ts does on a 401
    expect(sendQueue.texts()).toEqual(['first', 'second']);
    expect(queuedTexts.value).toEqual(['first', 'second']);
    expect(chatDraft.value).toBe(''); // not given back to the composer either: it is still queued
  });

  it('after the next login the queue is sent, in order', async () => {
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'x'));
    await submitText('first', 'text');
    session.value = null;
    post.mockImplementation(async (_p: string, body?: unknown) => cap(5, (body as { text: string }).text));
    const v = landedVersion.value;
    session.value = { csrfToken: 'again' };
    await vi.waitFor(() => expect(sendQueue.size()).toBe(0));
    expect(post).toHaveBeenLastCalledWith('/api/captures', { text: 'first', source: 'text' });
    expect(landedVersion.value).toBeGreaterThan(v);
    expect(landed.take(epoch()).map((c) => c.text)).toEqual(['first']);
  });

  it('logout (shellActive false) resets the queue and the feed', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(0, 'network', 'x'));
    await submitText('kept until logout', 'text');
    landed.push(cap(1), epoch());
    expect(sendQueue.size()).toBe(1);
    shellActive.value = false;
    expect(sendQueue.size()).toBe(0);
    expect(queuedTexts.value).toEqual([]);
    expect(landed.size()).toBe(0);
  });

  it('a rejected text goes back into the composer, never lost', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(400, 'validation_error', 'Bad text'));
    await submitText('too odd', 'text');
    expect(sendQueue.size()).toBe(0);
    expect(chatDraft.value).toBe('too odd');
    expect(flashMessage.value?.kind).toBe('error');
  });

  it('two fast submits are both sent, in order', async () => {
    const seen: string[] = [];
    vi.spyOn(api, 'post').mockImplementation(async (_p: string, body?: unknown) => {
      await Promise.resolve();
      const t = (body as { text: string }).text;
      seen.push(t);
      return cap(seen.length, t);
    });
    const a = submitText('one', 'text');
    const b = submitText('two', 'text');
    await Promise.all([a, b]);
    await drainQueue();
    expect(seen).toEqual(['one', 'two']);
    expect(sendQueue.size()).toBe(0);
    expect(landed.take(epoch()).map((c) => c.text)).toEqual(['one', 'two']);
  });
});

describe('sending flag', () => {
  it('is true while the head is in flight, false after success and after a transient stop', async () => {
    let release!: (c: Capture) => void;
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise<Capture>((r) => { release = r; }));
    const p = submitText('slow', 'text');
    expect(sending.value).toBe(true);
    release(cap(1, 'slow'));
    await p;
    expect(sending.value).toBe(false);
    post.mockRejectedValue(new ApiError(0, 'network', 'x'));
    await submitText('later', 'text');
    expect(sending.value).toBe(false); // stopped: the stream offers "Send now"
    expect(sendQueue.texts()).toEqual(['later']);
  });
});

describe('sendDraft', () => {
  it('trims, empties the draft and queues; blank text sends nothing', () => {
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(0, 'network', 'x'));
    chatDraft.value = '  hello  ';
    expect(sendDraft(chatDraft.value, 'text')).toBe(true);
    expect(chatDraft.value).toBe('');
    expect(sendQueue.texts()).toEqual(['hello']);
    expect(sendDraft('   ', 'text')).toBe(false);
  });
});

describe('isTransient', () => {
  it('session, network, rate-limit and server errors are retried; client errors are not', () => {
    for (const s of [0, 401, 429, 500, 502]) expect(isTransient(new ApiError(s, 'x', 'x'))).toBe(true);
    for (const s of [400, 403, 404, 409, 413]) expect(isTransient(new ApiError(s, 'x', 'x'))).toBe(false);
    expect(isTransient(new Error('boom'))).toBe(false);
  });
});

describe('question answering: the ask request', () => {
  const asked = (id: number): Capture => ({ ...cap(id, 'what did I promise?'), status: 'asked', filed: [] });
  const answered = (id: number): Capture => ({
    ...asked(id), status: 'answered', answer: { text: 'Found 1 item(s): Budget', sources: [{ kind: 'note', id: 3, title: 'Budget' }], redacted: false },
  });
  const askCalls = (post: { mock: { calls: unknown[][] } }) => post.mock.calls.filter((c) => String(c[0]).endsWith('/ask'));

  it('a send that lands as asked calls ask once, with no body, and stores the answer', async () => {
    streamCaptures.value = [];
    const post = vi.spyOn(api, 'post').mockImplementation(async (path: string) => (path.endsWith('/ask') ? answered(7) : asked(7)));
    await submitText('/ask what did I promise?', 'text');
    await vi.waitFor(() => expect(streamCaptures.value.find((c) => c.id === 7)?.status).toBe('answered'));
    expect(askCalls(post)).toHaveLength(1);
    expect(askCalls(post)[0]).toEqual(['/api/captures/7/ask']); // no body: sent the way undo is
    expect(askStates.value.size).toBe(0);
  });

  it('a send that lands filed never calls ask', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(cap(8));
    await submitText('/note hi', 'text');
    expect(askCalls(post)).toHaveLength(0);
  });

  it('loading captures (landed feed, session start) never calls ask', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(asked(9));
    landed.push(asked(9), epoch());
    landedVersion.value++;
    streamCaptures.value = [asked(9)];
    session.value = { csrfToken: 'again' };
    await Promise.resolve();
    expect(askCalls(post)).toHaveLength(0);
  });

  it('shows asking while in flight, and a failure leaves the capture asked with a failed state', async () => {
    streamCaptures.value = [asked(10)];
    let fail!: (e: unknown) => void;
    vi.spyOn(api, 'post').mockImplementation(() => new Promise<Capture>((_r, rej) => { fail = rej; }));
    const p = askQuestion(10);
    expect(askStates.value.get(10)).toEqual({ phase: 'asking' });
    fail(new ApiError(502, 'llm_failed', 'x'));
    await p;
    expect(askStates.value.get(10)).toMatchObject({ phase: 'failed', failure: 'failed' });
    expect(streamCaptures.value[0]?.status).toBe('asked');
  });

  it('a 409 clears the state and asks the Stream to reload', async () => {
    streamCaptures.value = [asked(13)];
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'not_asked', 'x'));
    const v = reloadVersion.value;
    await askQuestion(13);
    expect(reloadVersion.value).toBe(v + 1);
    expect(askStates.value.size).toBe(0);
  });

  it('one ask per capture at a time', async () => {
    let release!: (c: Capture) => void;
    const post = vi.spyOn(api, 'post').mockImplementation(() => new Promise<Capture>((r) => { release = r; }));
    const a = askQuestion(11);
    const b = askQuestion(11);
    release(answered(11));
    await Promise.all([a, b]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a late answer after a session change is dropped', async () => {
    streamCaptures.value = [asked(12)];
    let release!: (c: Capture) => void;
    vi.spyOn(api, 'post').mockImplementation(() => new Promise<Capture>((r) => { release = r; }));
    const p = askQuestion(12);
    session.value = null; // a 401: the epoch advances and the stream is cleared
    session.value = { csrfToken: 'new' };
    streamCaptures.value = [asked(12)];
    release(answered(12));
    await p;
    expect(streamCaptures.value[0]?.status).toBe('asked');
    expect(askStates.value.size).toBe(0);
  });
});
