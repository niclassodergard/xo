import { describe, expect, it } from 'vitest';
import { createOpenRouter } from './openrouter.ts';
import { LlmError } from './types.ts';

const KEY = 'sk-or-test-SECRET-key-123';
const T = { timeoutMs: 5000 };
const TEXT = 'private user sentence about the merger';

interface Call { url: string; init: RequestInit & { headers: Record<string, string> }; body: Record<string, any> }

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init: init as Call['init'],
      body: JSON.parse(String(init?.body)) as Record<string, any>,
    });
    return respond();
  }) as typeof fetch;
  return { f, calls };
}
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

describe('createOpenRouter', () => {
  it('chat: right URL, auth header, redirect error, zdr merged', async () => {
    const { f, calls } = fakeFetch(() => json({ ok: 1 }));
    const c = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f });
    expect(await c.chat({ model: 'm', messages: [] }, T)).toEqual({ ok: 1 });
    const call = calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    expect(call.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(call.body['model']).toBe('m');
    expect(call.body['provider']).toEqual({ zdr: true });
  });

  it('zdr off: provider.zdr is never sent, even if the caller passes it; other options are kept', async () => {
    const { f, calls } = fakeFetch(() => json({}));
    const c = createOpenRouter({ apiKey: KEY, zdr: false, fetch: f });
    await c.chat({ model: 'm' }, T);
    await c.chat({ provider: { zdr: true, require_parameters: true } }, T);
    await c.transcribe({ provider: { zdr: true } }, T);
    expect(calls[0]!.body['provider']).toEqual({});
    expect(calls[1]!.body['provider']).toEqual({ require_parameters: true });
    expect(calls[2]!.body['provider']).toEqual({});
    for (const call of calls) expect(call.body['provider']).not.toHaveProperty('zdr');
  });

  it('refuses bodies with plugins or tools', async () => {
    const { f, calls } = fakeFetch(() => json({}));
    const c = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f });
    await expect(c.chat({ plugins: [{ id: 'web' }] }, T)).rejects.toBeInstanceOf(LlmError);
    await expect(c.chat({ tools: [] }, T)).rejects.toBeInstanceOf(LlmError);
    await expect(c.transcribe({ plugins: [] }, T)).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(0);
  });

  it('a call times out by its own timeoutMs, not a client-wide one', async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => res(json({ ok: 1 })), 60);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('a', 'AbortError')); });
      })) as typeof fetch;
    const c = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f });
    await expect(c.chat({}, { timeoutMs: 10 })).rejects.toThrow(/timed out/);
    expect(await c.chat({}, { timeoutMs: 2000 })).toEqual({ ok: 1 });
  });

  it('a caller abort during the body read is reported as aborted', async () => {
    const ac = new AbortController();
    const f = (async () => {
      const body = new ReadableStream({
        start(ctrl) { ac.signal.addEventListener('abort', () => ctrl.error(new Error('x'))); },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const p = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f }).chat({}, { timeoutMs: 5000, signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect((await p as Error).message).toContain('aborted');
  });

  it('transcribe: right URL and zdr', async () => {
    const { f, calls } = fakeFetch(() => json({ text: 'x' }));
    await createOpenRouter({ apiKey: KEY, zdr: true, fetch: f }).transcribe({ model: 'w' }, T);
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(calls[0]!.body['provider']).toEqual({ zdr: true });
  });

  it('callers cannot switch zdr off, other provider options are kept', async () => {
    const { f, calls } = fakeFetch(() => json({}));
    const c = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f });
    await c.chat({ provider: { zdr: false, order: ['x'] } }, T);
    await c.transcribe({ provider: { zdr: false } }, T);
    await c.chat({ provider: 'nonsense' }, T);
    await c.chat({ provider: null }, T);
    for (const call of calls) expect(call.body['provider']['zdr']).toBe(true);
    expect(calls[0]!.body['provider']['order']).toEqual(['x']);
  });

  it('non-2xx maps to LlmError without key, body or text', async () => {
    const { f } = fakeFetch(() => json({ error: { message: `${KEY} ${TEXT}` } }, 404));
    const c = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f });
    const err = await c.chat({ messages: [{ content: TEXT }] }, T).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    const msg = (err as Error).message;
    expect(msg).toContain('404');
    expect(msg).not.toContain(KEY);
    expect(msg).not.toContain(TEXT);
    expect((err as Error).cause).toBeUndefined();
  });

  it('network failure maps to LlmError and drops the underlying message', async () => {
    const f = (async () => {
      throw new TypeError(`fetch failed ${KEY} ${TEXT}`);
    }) as typeof fetch;
    const err = await createOpenRouter({ apiKey: KEY, zdr: true, fetch: f }).chat({}, T).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain(TEXT);
    expect((err as Error).cause).toBeUndefined();
  });

  it('times out', async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const err = await createOpenRouter({ apiKey: KEY, zdr: true, fetch: f }).chat({}, { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toContain('timed out');
  });

  it('honours a caller abort signal', async () => {
    const f = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const ac = new AbortController();
    const p = createOpenRouter({ apiKey: KEY, zdr: true, fetch: f }).chat({}, { timeoutMs: 1000, signal: ac.signal }).catch((e: unknown) => e);
    ac.abort();
    const err = await p;
    expect(err).toBeInstanceOf(LlmError);
    expect((err as Error).message).toContain('aborted');
  });

  it('invalid JSON and oversized responses are LlmErrors', async () => {
    const bad = fakeFetch(() => new Response('not json', { status: 200 }));
    await expect(createOpenRouter({ apiKey: KEY, zdr: true, fetch: bad.f }).chat({}, T)).rejects.toBeInstanceOf(LlmError);
    const big = fakeFetch(() => new Response('x'.repeat(1_100_000), { status: 200 }));
    await expect(createOpenRouter({ apiKey: KEY, zdr: true, fetch: big.f }).chat({}, T)).rejects.toBeInstanceOf(LlmError);
  });

  it('refuses an empty key', () => {
    expect(() => createOpenRouter({ apiKey: '', zdr: true })).toThrow();
  });
});
